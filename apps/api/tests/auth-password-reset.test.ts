/**
 * Tests for POST /api/auth/password-reset/{request,confirm} per
 * specs/api/auth.md + specs/behaviors/account-migration.md.
 *
 * The request endpoint is intentionally enumeration-safe: every path
 * returns 202 regardless of whether the address resolved. The tests
 * verify that the *side effect* (a `PasswordToken` record on disk)
 * happens only in the resolvable + has-credential + has-email branch.
 *
 * The confirm endpoint seeds a token directly via the store so the
 * tests don't have to round-trip the plaintext through the notifier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';
import { verifyLegacyPassword } from '../src/auth/legacy-password.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';

let testIpCounter = 0;
function nextTestIp(): string {
  testIpCounter += 1;
  return `10.6.${Math.floor(testIpCounter / 250)}.${testIpCounter % 250}`;
}

async function seedPerson(
  repoPath: string,
  slug: string,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const fields = {
    id,
    slug,
    fullName: slug
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
    accountLevel: 'user',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...extra,
  };
  const toml = Object.entries(fields)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join('\n');
  await seedRawToml(
    repoPath,
    `people/${slug}.toml`,
    toml + '\n',
    `seed people/${slug}`,
  );
}

async function appendJsonl(filePath: string, record: object): Promise<void> {
  let content = '';
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    // first write
  }
  await writeFile(filePath, content + JSON.stringify(record) + '\n');
}

async function seedPrivateProfile(
  privatePath: string,
  personId: string,
  email: string,
): Promise<void> {
  await appendJsonl(join(privatePath, 'profiles.jsonl'), {
    personId,
    email,
    emailRefreshedAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  });
}

async function seedLegacyPassword(
  privatePath: string,
  personId: string,
  passwordHash: string,
): Promise<void> {
  await appendJsonl(join(privatePath, 'legacy-passwords.jsonl'), {
    personId,
    passwordHash,
    importedAt: '2026-05-01T00:00:00Z',
  });
}

async function readPasswordTokens(
  privatePath: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const content = await readFile(join(privatePath, 'password-tokens.jsonl'), 'utf8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readLegacyPasswords(
  privatePath: string,
): Promise<Array<{ personId: string; passwordHash: string; lastUsedAt?: string }>> {
  try {
    const content = await readFile(join(privatePath, 'legacy-passwords.jsonl'), 'utf8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function buildTestApp(
  dataPath: string,
  privatePath: string,
): Promise<FastifyInstance> {
  return buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataPath,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privatePath,
      CFP_JWT_SIGNING_KEY: JWT_KEY,
      NODE_ENV: 'test',
    },
  });
}

describe('POST /api/auth/password-reset/request', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const fullPersonId = '01951a3c-0000-7000-8000-0000bbbbbbb1';
  const noCredPersonId = '01951a3c-0000-7000-8000-0000bbbbbbb2';
  const noEmailPersonId = '01951a3c-0000-7000-8000-0000bbbbbbb3';
  const correctPassword = 'orig-pw-hunter2';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();

    // The happy-path target: profile with email + legacy credential.
    await seedPerson(dataRepo.path, 'reset-target', fullPersonId);
    await seedPrivateProfile(privateStore.path, fullPersonId, 'target@example.com');
    const sha1 = createHash('sha1').update(correctPassword).digest('hex');
    await seedLegacyPassword(privateStore.path, fullPersonId, sha1);

    // Has email but no legacy credential (e.g., GitHub-only signup).
    // Reset should be a silent no-op.
    await seedPerson(dataRepo.path, 'no-cred', noCredPersonId);
    await seedPrivateProfile(privateStore.path, noCredPersonId, 'nocred@example.com');

    // Has credential but no profile/email — reset can't deliver, so
    // silent no-op.
    await seedPerson(dataRepo.path, 'no-email', noEmailPersonId);
    await seedLegacyPassword(privateStore.path, noEmailPersonId, sha1);

    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('always returns 202 (anti-enumeration) for an unknown account', async () => {
    const before = await readPasswordTokens(privateStore.path);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      remoteAddress: nextTestIp(),
      payload: { usernameOrEmail: 'completely-nonexistent-account' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json<{ success: true; data: { delivered: boolean } }>().data.delivered).toBe(true);

    const after = await readPasswordTokens(privateStore.path);
    expect(after.length).toBe(before.length);
  });

  it('silently no-ops when the person has no legacy credential', async () => {
    const before = await readPasswordTokens(privateStore.path);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      remoteAddress: nextTestIp(),
      payload: { usernameOrEmail: 'no-cred' },
    });

    expect(res.statusCode).toBe(202);
    const after = await readPasswordTokens(privateStore.path);
    expect(after.length).toBe(before.length);
  });

  it('silently no-ops when the person has no email on file', async () => {
    const before = await readPasswordTokens(privateStore.path);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      remoteAddress: nextTestIp(),
      payload: { usernameOrEmail: 'no-email' },
    });

    expect(res.statusCode).toBe(202);
    const after = await readPasswordTokens(privateStore.path);
    expect(after.length).toBe(before.length);
  });

  it('persists a PasswordToken when the target resolves with email + credential', async () => {
    const before = await readPasswordTokens(privateStore.path);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      remoteAddress: nextTestIp(),
      payload: { usernameOrEmail: 'reset-target' },
    });

    expect(res.statusCode).toBe(202);

    const after = await readPasswordTokens(privateStore.path);
    expect(after.length).toBe(before.length + 1);
    const newest = after[after.length - 1] as Record<string, unknown>;
    expect(newest['personId']).toBe(fullPersonId);
    expect(newest['usedAt']).toBeNull();
    expect(typeof newest['tokenHash']).toBe('string');
    expect((newest['tokenHash'] as string).length).toBe(64);
    // 1h expiry per spec
    const expires = new Date(newest['expiresAt'] as string).getTime();
    const issued = new Date(newest['issuedAt'] as string).getTime();
    expect(expires - issued).toBeGreaterThanOrEqual(59 * 60 * 1000);
    expect(expires - issued).toBeLessThanOrEqual(61 * 60 * 1000);
  });

  it('resolves usernameOrEmail by email', async () => {
    const before = await readPasswordTokens(privateStore.path);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      remoteAddress: nextTestIp(),
      payload: { usernameOrEmail: 'TARGET@example.com' },
    });

    expect(res.statusCode).toBe(202);
    const after = await readPasswordTokens(privateStore.path);
    expect(after.length).toBe(before.length + 1);
  });
});

describe('POST /api/auth/password-reset/confirm', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const personId = '01951a3c-0000-7000-8000-0000ccccccc1';
  const noCredPersonId = '01951a3c-0000-7000-8000-0000ccccccc2';
  const oldPassword = 'orig-pw-hunter2';
  const newPassword = 'fresh-pw-foxtrot7';

  /**
   * Mint a token plaintext + persist its hash through the live app's
   * private store. Writing directly to the .jsonl file would skip the
   * boot-time in-memory map; routes only read from the map, so disk-
   * only seeds yield false 401s. Going through the store updates both.
   */
  async function mintToken(
    targetId: string,
    opts: { expiresAt?: string; usedAt?: string } = {},
  ): Promise<string> {
    const plaintext = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(plaintext).digest('hex');
    const now = new Date();
    await app.store.private.putPasswordToken({
      tokenHash,
      personId: targetId,
      issuedAt: now.toISOString(),
      expiresAt: opts.expiresAt ?? new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      usedAt: opts.usedAt ?? null,
    });
    return plaintext;
  }

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();

    await seedPerson(dataRepo.path, 'confirm-target', personId);
    await seedPrivateProfile(privateStore.path, personId, 'confirm@example.com');
    const sha1 = createHash('sha1').update(oldPassword).digest('hex');
    await seedLegacyPassword(privateStore.path, personId, sha1);

    // No-credential person — confirm should reject with invalid_token
    // even when the token itself resolves correctly.
    await seedPerson(dataRepo.path, 'confirm-no-cred', noCredPersonId);
    await seedPrivateProfile(privateStore.path, noCredPersonId, 'nocred-confirm@example.com');

    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('rejects an unknown token with 401 invalid_token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      remoteAddress: nextTestIp(),
      payload: { token: 'never-issued-token', password: newPassword },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
  });

  it('rejects an expired token with 401 invalid_token', async () => {
    const plaintext = await mintToken(personId, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      remoteAddress: nextTestIp(),
      payload: { token: plaintext, password: newPassword },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
  });

  it('rejects an already-used token with 401 invalid_token', async () => {
    const plaintext = await mintToken(personId, {
      usedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      remoteAddress: nextTestIp(),
      payload: { token: plaintext, password: newPassword },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
  });

  it('rejects with 401 when the person has no credential on file', async () => {
    const plaintext = await mintToken(noCredPersonId);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      remoteAddress: nextTestIp(),
      payload: { token: plaintext, password: newPassword },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
  });

  it('rejects with 422 when the new password is too short', async () => {
    const plaintext = await mintToken(personId);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      remoteAddress: nextTestIp(),
      payload: { token: plaintext, password: 'short' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('succeeds: sets cookies, rotates credential, marks token used', async () => {
    const plaintext = await mintToken(personId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      remoteAddress: nextTestIp(),
      payload: { token: plaintext, password: newPassword },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: true; data: { person: { slug: string } } }>();
    expect(body.data.person.slug).toBe('confirm-target');

    const cookies = res.headers['set-cookie'];
    const cookieStr = Array.isArray(cookies) ? cookies.join('\n') : (cookies ?? '');
    expect(cookieStr).toContain('cfp_session=');
    expect(cookieStr).toContain('cfp_refresh=');

    // Credential rotated to argon2id + lastUsedAt populated
    const creds = await readLegacyPasswords(privateStore.path);
    const rotated = creds.find((c) => c.personId === personId);
    expect(rotated).toBeDefined();
    expect(rotated!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(rotated!.lastUsedAt).toBeDefined();
    // The new password verifies against the new hash; the old one doesn't.
    const newOk = await verifyLegacyPassword(newPassword, rotated!.passwordHash);
    const oldOk = await verifyLegacyPassword(oldPassword, rotated!.passwordHash);
    expect(newOk.valid).toBe(true);
    expect(oldOk.valid).toBe(false);

    // Token marked used
    const tokens = await readPasswordTokens(privateStore.path);
    const tokenHash = createHash('sha256').update(plaintext).digest('hex');
    const consumed = tokens.find((t) => t['tokenHash'] === tokenHash);
    expect(consumed).toBeDefined();
    expect(consumed!['usedAt']).not.toBeNull();
  });

  it('rejects the same token a second time (single-use)', async () => {
    const plaintext = await mintToken(personId);

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      remoteAddress: nextTestIp(),
      payload: { token: plaintext, password: 'reusable-pw-test' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      remoteAddress: nextTestIp(),
      payload: { token: plaintext, password: 'something-else-1' },
    });
    expect(second.statusCode).toBe(401);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
  });

  it('new password works for /api/auth/login (end-to-end)', async () => {
    // The previous test rotated the credential to `newPassword`; the
    // second test rotated again to 'reusable-pw-test'. Sign in with the
    // most recent.
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: nextTestIp(),
      payload: { usernameOrEmail: 'confirm-target', password: 'reusable-pw-test' },
    });
    expect(res.statusCode).toBe(200);
  });
});
