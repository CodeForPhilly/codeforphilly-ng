/**
 * Tests for POST /api/people/:slug/account-level (administrator-only).
 *
 * Spec: specs/api/people.md → POST /api/people/:slug/account-level
 *
 * Covers:
 *  - anonymous → 401
 *  - regular user caller → 403
 *  - staff (non-admin) caller → 403
 *  - invalid level → 422 (schema validation)
 *  - admin promotes user → 200, level reflected
 *  - admin demotes staff → 200
 *  - idempotent no-op (same level) → 200
 *  - last-administrator self-demotion → 422
 *  - demoting an admin while another admin exists → 200
 *  - audit trail: commit carries Action + Previous/New-Account-Level trailers
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';

const IDS = {
  alice: '01951a3d-0000-7000-8000-a0000000cafe',
  bob: '01951a3d-0000-7000-8000-b0000000cafe',
  staff: '01951a3d-0000-7000-8000-c0000000cafe',
  admin: '01951a3d-0000-7000-8000-d0000000cafe',
};

async function mintCookies(
  personId: string,
  level: 'user' | 'staff' | 'administrator' = 'user',
): Promise<string> {
  const { accessToken } = await mintSessionFor(personId, level, JWT_KEY);
  return `cfp_session=${accessToken}`;
}

interface PersonDetailResponse {
  success: boolean;
  data: { slug: string; accountLevel?: string };
}

describe('POST /api/people/:slug/account-level', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();

    for (const [slug, id, level] of [
      ['alice', IDS.alice, 'user'],
      ['bob', IDS.bob, 'user'],
      ['staff-user', IDS.staff, 'staff'],
      ['admin-user', IDS.admin, 'administrator'],
    ] as const) {
      const toml = [
        `id = "${id}"`,
        `slug = "${slug}"`,
        `fullName = "Test ${slug}"`,
        `accountLevel = "${level}"`,
        `createdAt = "2026-05-01T00:00:00Z"`,
        `updatedAt = "2026-05-01T00:00:00Z"`,
      ].join('\n');
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
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  const post = (slug: string, body: unknown, cookie?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/people/${slug}/account-level`,
      headers: cookie ? { cookie } : {},
      payload: body as object,
    });

  it('anonymous → 401', async () => {
    const res = await post('alice', { level: 'staff' });
    expect(res.statusCode).toBe(401);
  });

  it('regular user caller → 403', async () => {
    const res = await post('alice', { level: 'staff' }, await mintCookies(IDS.bob));
    expect(res.statusCode).toBe(403);
  });

  it('staff (non-admin) caller → 403', async () => {
    const res = await post('alice', { level: 'staff' }, await mintCookies(IDS.staff, 'staff'));
    expect(res.statusCode).toBe(403);
  });

  it('invalid level → 422 (schema validation)', async () => {
    const res = await post('alice', { level: 'superuser' }, await mintCookies(IDS.admin, 'administrator'));
    expect(res.statusCode).toBe(422);
  });

  it('admin promotes a user to staff → 200, level reflected', async () => {
    const res = await post('alice', { level: 'staff' }, await mintCookies(IDS.admin, 'administrator'));
    expect(res.statusCode).toBe(200);
    const body = res.json<PersonDetailResponse>();
    expect(body.success).toBe(true);
    // accountLevel is visible to the admin (staff-level) caller.
    expect(body.data.accountLevel).toBe('staff');
  });

  it('admin demotes staff to user → 200', async () => {
    const res = await post('staff-user', { level: 'user' }, await mintCookies(IDS.admin, 'administrator'));
    expect(res.statusCode).toBe(200);
    expect(res.json<PersonDetailResponse>().data.accountLevel).toBe('user');
  });

  it('idempotent: setting the same level → 200 no-op', async () => {
    // alice is now 'staff' from the promote test.
    const res = await post('alice', { level: 'staff' }, await mintCookies(IDS.admin, 'administrator'));
    expect(res.statusCode).toBe(200);
    expect(res.json<PersonDetailResponse>().data.accountLevel).toBe('staff');
  });

  it('last administrator self-demotion → 422', async () => {
    // admin-user is the sole administrator.
    const res = await post('admin-user', { level: 'user' }, await mintCookies(IDS.admin, 'administrator'));
    expect(res.statusCode).toBe(422);
  });

  it('can demote an administrator when another administrator exists → 200', async () => {
    const adminCookie = await mintCookies(IDS.admin, 'administrator');
    // Promote bob to administrator first (now two admins).
    const promote = await post('bob', { level: 'administrator' }, adminCookie);
    expect(promote.statusCode).toBe(200);
    // Now admin-user can be demoted — bob remains.
    const demote = await post('admin-user', { level: 'staff' }, adminCookie);
    expect(demote.statusCode).toBe(200);
    expect(demote.json<PersonDetailResponse>().data.accountLevel).toBe('staff');
  });

  it('audit trail: commit carries Action + Previous/New-Account-Level trailers', async () => {
    // Make a fresh change and inspect the resulting commit on the bare repo.
    await post('staff-user', { level: 'staff' }, await mintCookies(IDS.admin, 'administrator'));
    const msg = execFileSync('git', ['-C', dataRepo.path, 'log', '-1', '--format=%B', 'main'], {
      encoding: 'utf8',
    });
    expect(msg).toContain('Action: account-level.change');
    expect(msg).toContain('Previous-Account-Level: user');
    expect(msg).toContain('New-Account-Level: staff');
  });
});
