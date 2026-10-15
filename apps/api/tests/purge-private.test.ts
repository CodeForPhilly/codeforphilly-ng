/**
 * Purge removes private data too, the scheduled sweep is opt-in per pod, and
 * the admin orphan cleanup clears private data left by earlier purges.
 * Specs: behaviors/person-lifecycle.md → Purge, Scheduled spam purge;
 * api/moderation.md → POST /api/admin/private-data/purge-orphans.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { scheduledPurgeEnabled } from '../src/plugins/spam-purge.js';
import { FilesystemPrivateStore } from '../src/store/private/index.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const T = '2026-05-01T00:00:00Z';
const ID = {
  alice: '01951a3c-0000-7000-8000-a9000000cafe',
  bob: '01951a3c-0000-7000-8000-b9000000cafe',
  admin: '01951a3c-0000-7000-8000-d9000000cafe',
  staff: '01951a3c-0000-7000-8000-c9000000cafe',
  ghost: '01951a3c-0000-7000-8000-e9000000beef',
};

const profile = (personId: string, email: string) => ({ personId, email, emailRefreshedAt: T, updatedAt: T });
const claim = (id: string, claimedPersonId: string) => ({
  id,
  type: 'pre-onboarding' as const,
  claimedPersonId,
  claimedSlug: 'someone',
  requesterGithubLogin: 'someone',
  requesterGithubId: 1,
  requesterPersonId: null,
  evidence: '',
  status: 'open' as const,
  submittedAt: T,
  reviewedAt: null,
  reviewedBy: null,
  reviewedReason: null,
});

describe('scheduledPurgeEnabled', () => {
  it('runs only with CFP_SCHEDULED_PURGE=true outside tests', () => {
    expect(scheduledPurgeEnabled({ NODE_ENV: 'production', CFP_SCHEDULED_PURGE: 'true' })).toBe(true);
    expect(scheduledPurgeEnabled({ NODE_ENV: 'production', CFP_SCHEDULED_PURGE: 'false' })).toBe(false);
    expect(scheduledPurgeEnabled({ NODE_ENV: 'test', CFP_SCHEDULED_PURGE: 'true' })).toBe(false);
  });
});

describe('PrivateStoreTx.deletePersonData', () => {
  it('removes profile, legacy password, reset tokens and claim requests, and only that person\'s', async () => {
    const dir = await createPrivateStorageDir();
    try {
      const store = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: dir.path });
      await store.load();
      await store.putProfile(profile(ID.alice, 'alice@example.org'));
      await store.putProfile(profile(ID.bob, 'bob@example.org'));
      await store.putLegacyPassword({ personId: ID.alice, passwordHash: 'x', importedAt: T });
      await store.putPasswordToken({ tokenHash: 'a'.repeat(64), personId: ID.alice, issuedAt: T, expiresAt: T });
      await store.putClaimRequest(claim('01951a3c-0000-7000-8000-0000000000c1', ID.alice));
      await store.putClaimRequest(claim('01951a3c-0000-7000-8000-0000000000c2', ID.bob));

      await store.transact(async (tx) => tx.deletePersonData(ID.alice));

      // Read back from disk, not just memory.
      const reread = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: dir.path });
      await reread.load();
      expect(await reread.getProfile(ID.alice)).toBeNull();
      expect(await reread.findPersonIdByEmail('alice@example.org')).toBeNull();
      expect(await reread.getLegacyPassword(ID.alice)).toBeNull();
      expect(await reread.getPasswordToken('a'.repeat(64))).toBeNull();
      expect((await reread.listAllClaimRequests()).map((r) => r.claimedPersonId)).toEqual([ID.bob]);
      expect(await reread.getProfile(ID.bob)).not.toBeNull();
    } finally {
      await dir.cleanup();
    }
  });
});

describe('purge and the orphan cleanup', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const cookie = async (id: string, level: 'user' | 'staff' | 'administrator') =>
    `cfp_session=${(await mintSessionFor(id, level, JWT_KEY)).accessToken}`;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    for (const [slug, id, level] of [
      ['alice', ID.alice, 'user'],
      ['bob', ID.bob, 'user'],
      ['admin-user', ID.admin, 'administrator'],
      ['staff-user', ID.staff, 'staff'],
    ] as const) {
      const toml = [`id = "${id}"`, `slug = "${slug}"`, `fullName = "Test ${slug}"`, `accountLevel = "${level}"`, `createdAt = "${T}"`, `updatedAt = "${T}"`].join('\n');
      await seedRawToml(dataRepo.path, `people/${slug}.toml`, toml, `seed ${slug}`);
    }
    app = await buildApp({
      serverOptions: { logger: false },
      overrideEnv: {
        CFP_DATA_REPO_PATH: dataRepo.path,
        STORAGE_BACKEND: 'filesystem',
        CFP_PRIVATE_STORAGE_PATH: privateStore.path,
        CFP_JWT_SIGNING_KEY: JWT_KEY,
        NODE_ENV: 'test',
      },
    });
    await app.store.private.putProfile(profile(ID.alice, 'alice@example.org'));
    await app.store.private.putProfile(profile(ID.bob, 'bob@example.org'));
    // Left behind by a purge from before purge cleaned up private data.
    await app.store.private.putProfile(profile(ID.ghost, 'ghost@example.org'));
    await app.store.private.putLegacyPassword({ personId: ID.ghost, passwordHash: 'x', importedAt: T });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('Purge deletes the person\'s private profile in the same transaction', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/people/alice/purge', headers: { cookie: await cookie(ID.admin, 'administrator') } });
    expect(res.statusCode).toBe(204);
    expect(await app.store.private.getProfile(ID.alice)).toBeNull();
    expect(await app.store.private.getProfile(ID.bob)).not.toBeNull();
  });

  it('the orphan cleanup is admin-only, counts first, then deletes', async () => {
    const url = '/api/admin/private-data/purge-orphans';
    const staff = await app.inject({ method: 'POST', url, payload: { apply: false }, headers: { cookie: await cookie(ID.staff, 'staff') } });
    expect(staff.statusCode).toBe(404);

    const admin = await cookie(ID.admin, 'administrator');
    const dry = await app.inject({ method: 'POST', url, payload: { apply: false }, headers: { cookie: admin } });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().data).toEqual({ applied: false, orphanPeople: 1, profiles: 1, legacyPasswords: 1, claimRequests: 0, sessions: 0 });
    expect(dry.body).not.toContain('ghost@example.org');
    expect(await app.store.private.getProfile(ID.ghost)).not.toBeNull();

    const applied = await app.inject({ method: 'POST', url, payload: { apply: true }, headers: { cookie: admin } });
    expect(applied.json().data.applied).toBe(true);
    expect(await app.store.private.getProfile(ID.ghost)).toBeNull();
    expect(await app.store.private.getLegacyPassword(ID.ghost)).toBeNull();
    expect(await app.store.private.getProfile(ID.bob)).not.toBeNull();

    const again = await app.inject({ method: 'POST', url, payload: { apply: false }, headers: { cookie: admin } });
    expect(again.json().data.orphanPeople).toBe(0);
  });
});
