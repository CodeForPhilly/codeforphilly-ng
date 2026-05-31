/**
 * Tests for POST /api/auth/login per specs/api/auth.md +
 * specs/behaviors/account-migration.md + password-hash-rotation.md.
 *
 * Each test uses a unique remoteAddress so the 10/min/IP rate cap on
 * /api/auth/* doesn't cross-contaminate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const exec = promisify(execFile);
const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';

let testIpCounter = 0;
function nextTestIp(): string {
  testIpCounter += 1;
  return `10.5.${Math.floor(testIpCounter / 250)}.${testIpCounter % 250}`;
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
    .map(([k, v]) =>
      typeof v === 'number'
        ? `${k} = ${v}`
        : `${k} = ${JSON.stringify(v)}`,
    )
    .join('\n');
  await seedRawToml(
    repoPath,
    `people/${slug}.toml`,
    toml + '\n',
    `seed people/${slug}`,
  );
}

async function seedPrivateProfile(
  privatePath: string,
  personId: string,
  email: string,
): Promise<void> {
  const filePath = join(privatePath, 'profiles.jsonl');
  const profile = {
    personId,
    email,
    emailRefreshedAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
  let content = '';
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    // first write
  }
  await writeFile(filePath, content + JSON.stringify(profile) + '\n');
}

async function seedLegacyPassword(
  privatePath: string,
  personId: string,
  passwordHash: string,
): Promise<void> {
  const filePath = join(privatePath, 'legacy-passwords.jsonl');
  const cred = {
    personId,
    passwordHash,
    importedAt: '2026-05-01T00:00:00Z',
  };
  let content = '';
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    // first write
  }
  await writeFile(filePath, content + JSON.stringify(cred) + '\n');
}

async function readLegacyPasswords(
  privatePath: string,
): Promise<Array<{ personId: string; passwordHash: string; lastUsedAt?: string }>> {
  const filePath = join(privatePath, 'legacy-passwords.jsonl');
  try {
    const content = await readFile(filePath, 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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

describe('POST /api/auth/login', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const sha1PersonId = '01951a3c-0000-7000-8000-0000aaaaaaa1';
  const argon2PersonId = '01951a3c-0000-7000-8000-0000aaaaaaa2';
  const linkedPersonId = '01951a3c-0000-7000-8000-0000aaaaaaa3';
  const correctPassword = 'hunter2-correct';
  const wrongPassword = 'definitely-wrong';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();

    // SHA-1 user — matches laddr's production hashing
    await seedPerson(dataRepo.path, 'sha1-login', sha1PersonId);
    await seedPrivateProfile(privateStore.path, sha1PersonId, 'sha1@example.com');
    const sha1 = createHash('sha1').update(correctPassword).digest('hex');
    await seedLegacyPassword(privateStore.path, sha1PersonId, sha1);

    // Already-argon2id user (e.g., previously rehashed) — login should
    // succeed and not need a rehash.
    await seedPerson(dataRepo.path, 'argon2-login', argon2PersonId);
    await seedPrivateProfile(privateStore.path, argon2PersonId, 'argon2@example.com');
    const argon2Hash = await (async () => {
      const { rehashPassword } = await import('../src/auth/legacy-password.js');
      return rehashPassword(correctPassword);
    })();
    await seedLegacyPassword(privateStore.path, argon2PersonId, argon2Hash);

    // GitHub-linked user with a password credential — login should work
    // (kept for migrated users who have linked GitHub but haven't sunset
    // their password) and /api/auth/me should report hasGitHubLink: true.
    await seedPerson(dataRepo.path, 'linked-login', linkedPersonId, {
      githubUserId: 7777,
      githubLogin: 'linked-gh-login',
      githubLinkedAt: '2026-04-01T00:00:00Z',
    });
    await seedPrivateProfile(privateStore.path, linkedPersonId, 'linked@example.com');
    await seedLegacyPassword(privateStore.path, linkedPersonId, sha1);

    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  describe('happy path', () => {
    it('signs in with correct password against a SHA-1 hash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'sha1-login', password: correctPassword },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ success: true; data: { person: { slug: string } } }>();
      expect(body.data.person.slug).toBe('sha1-login');

      // Session cookies set
      const cookies = res.headers['set-cookie'];
      const cookieStr = Array.isArray(cookies) ? cookies.join('\n') : (cookies ?? '');
      expect(cookieStr).toContain('cfp_session=');
      expect(cookieStr).toContain('cfp_refresh=');
    });

    it('resolves usernameOrEmail by email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'argon2@example.com', password: correctPassword },
      });
      expect(res.statusCode).toBe(200);
    });

    it('signs in a GitHub-linked Person who still has a password credential', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'linked-login', password: correctPassword },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rehashes a SHA-1 credential to argon2id on successful login', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'sha1-login', password: correctPassword },
      });
      expect(res.statusCode).toBe(200);

      const creds = await readLegacyPasswords(privateStore.path);
      const cred = creds.find((c) => c.personId === sha1PersonId);
      expect(cred).toBeDefined();
      expect(cred!.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(cred!.lastUsedAt).toBeDefined();
    });

    it('does not rotate an already-argon2id credential', async () => {
      const credsBefore = await readLegacyPasswords(privateStore.path);
      const before = credsBefore.find((c) => c.personId === argon2PersonId);
      expect(before).toBeDefined();
      const hashBefore = before!.passwordHash;

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'argon2-login', password: correctPassword },
      });
      expect(res.statusCode).toBe(200);

      const credsAfter = await readLegacyPasswords(privateStore.path);
      const after = credsAfter.find((c) => c.personId === argon2PersonId);
      expect(after).toBeDefined();
      // Hash bytes unchanged when needsRehash is false
      expect(after!.passwordHash).toBe(hashBefore);
      // But lastUsedAt is refreshed
      expect(after!.lastUsedAt).toBeDefined();
    });
  });

  describe('failure paths (uniform 401)', () => {
    it('wrong password returns 401 invalid_credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'sha1-login', password: wrongPassword },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ success: false; error: { code: string } }>();
      expect(body.error.code).toBe('invalid_credentials');
    });

    it('unknown user returns 401 invalid_credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'no-such-user', password: correctPassword },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ success: false; error: { code: string } }>();
      expect(body.error.code).toBe('invalid_credentials');
    });

    it('unknown email returns 401 invalid_credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'nobody@example.com', password: correctPassword },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects missing body fields with 400 (schema validation)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'sha1-login' },
      });
      // Fastify/Ajv validation surfaces as 422 via our error mapper
      // (ApiValidationError); 400 if a different middleware caught it.
      // Either way, not 200.
      expect([400, 422]).toContain(res.statusCode);
    });
  });

  describe('GET /api/auth/me after login', () => {
    it('returns hasGitHubLink: false + lastLoginMethod: legacy_password for SHA-1 user', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'sha1-login', password: correctPassword },
      });
      expect(loginRes.statusCode).toBe(200);
      const sessionCookie = parseSessionCookie(loginRes.headers['set-cookie']);
      expect(sessionCookie).toBeDefined();

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        remoteAddress: nextTestIp(),
        cookies: { cfp_session: sessionCookie! },
      });
      expect(meRes.statusCode).toBe(200);
      const body = meRes.json<{
        data: {
          person: { slug: string } | null;
          hasGitHubLink: boolean;
          lastLoginMethod: string | null;
        };
      }>();
      expect(body.data.person?.slug).toBe('sha1-login');
      expect(body.data.hasGitHubLink).toBe(false);
      expect(body.data.lastLoginMethod).toBe('legacy_password');
    });

    it('returns hasGitHubLink: true for a github-linked user', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: nextTestIp(),
        payload: { usernameOrEmail: 'linked-login', password: correctPassword },
      });
      expect(loginRes.statusCode).toBe(200);
      const sessionCookie = parseSessionCookie(loginRes.headers['set-cookie']);

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        remoteAddress: nextTestIp(),
        cookies: { cfp_session: sessionCookie! },
      });
      const body = meRes.json<{
        data: { hasGitHubLink: boolean; lastLoginMethod: string | null };
      }>();
      expect(body.data.hasGitHubLink).toBe(true);
      expect(body.data.lastLoginMethod).toBe('legacy_password');
    });

    it('returns anonymous fields when no session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        remoteAddress: nextTestIp(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: {
          person: unknown;
          accountLevel: string;
          hasGitHubLink: boolean;
          lastLoginMethod: null;
        };
      }>();
      expect(body.data.person).toBeNull();
      expect(body.data.accountLevel).toBe('anonymous');
      expect(body.data.hasGitHubLink).toBe(false);
      expect(body.data.lastLoginMethod).toBeNull();
    });
  });
});

function parseSessionCookie(setCookie: string | string[] | undefined): string | undefined {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of cookies) {
    const match = /^cfp_session=([^;]+)/.exec(c);
    if (match) return match[1];
  }
  return undefined;
}

// Silence unused-helper warnings since the suite is the only consumer.
void exec;
void mkdtemp;
void tmpdir;
