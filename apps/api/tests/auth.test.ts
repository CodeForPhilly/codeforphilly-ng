/**
 * Tests for auth-jwt-substrate plan validation criteria.
 *
 * Covers:
 *  - mintSessionFor issues valid JWTs accepted by verifier
 *  - GET /api/auth/me with valid cfp_session cookie
 *  - GET /api/auth/me with no cookie → anonymous 200
 *  - Expired access JWT → anonymous (ME never 401s)
 *  - POST /api/auth/refresh with valid refresh JWT → new pair
 *  - POST /api/auth/refresh with revoked refresh → 401 refresh_token_revoked
 *  - POST /api/auth/logout revokes both jtis, clears cookies
 *  - GET /api/auth/sessions lists non-revoked sessions, current marked true
 *  - POST /api/auth/sessions/:jti/revoke with current → 409 cannot_revoke_current_session
 *  - OAuth endpoints return 501 oauth_not_yet_wired
 *  - Authenticated reads use account-based rate limits (300/min)
 *
 * Architecture note: each `describe` block manages its own app lifecycle to
 * keep test isolation tight without rebuilding the app for every test case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { verifyAccess, verifyRefresh } from '../src/auth/jwt.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';

const exec = promisify(execFile);
const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';

async function buildTestApp(
  dataPath: string,
  privatePath: string,
  overrides: Partial<Record<string, string>> = {},
): Promise<FastifyInstance> {
  return buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataPath,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privatePath,
      CFP_JWT_SIGNING_KEY: JWT_KEY,
      NODE_ENV: 'test',
      ...overrides,
    },
  });
}

/**
 * Seed a minimal Person TOML into the repo and commit it.
 * Returns the person ID used.
 */
async function seedPerson(
  repoDir: string,
  slug: string,
  id: string,
  accountLevel = 'user',
): Promise<void> {
  const git = (...args: string[]) => exec('git', args, { cwd: repoDir });
  const personToml = [
    `id = "${id}"`,
    `slug = "${slug}"`,
    `fullName = "Test ${slug}"`,
    `accountLevel = "${accountLevel}"`,
    `createdAt = "2026-05-01T00:00:00Z"`,
    `updatedAt = "2026-05-01T00:00:00Z"`,
  ].join('\n');

  await mkdir(join(repoDir, 'people'), { recursive: true });
  await writeFile(join(repoDir, 'people', `${slug}.toml`), personToml);
  await git('add', `people/${slug}.toml`);
  await git(
    '-c', 'user.email=test@cfp.test',
    '-c', 'user.name=test',
    'commit', '-m', `seed person ${slug}`,
  );
}

// ---------------------------------------------------------------------------
// JWT primitives — no app needed
// ---------------------------------------------------------------------------

describe('mintSessionFor', () => {
  it('issues valid access + refresh JWTs that the verifier accepts', async () => {
    const personId = '01951a3c-0000-7000-8000-000000000001';
    const { accessToken, refreshToken, accessJti, refreshJti } = await mintSessionFor(
      personId,
      'user',
      JWT_KEY,
    );

    expect(typeof accessToken).toBe('string');
    expect(typeof refreshToken).toBe('string');

    const accessClaims = await verifyAccess(accessToken, JWT_KEY);
    expect(accessClaims.sub).toBe(personId);
    expect(accessClaims.jti).toBe(accessJti);
    expect(accessClaims.accountLevel).toBe('user');

    const refreshClaims = await verifyRefresh(refreshToken, JWT_KEY);
    expect(refreshClaims.sub).toBe(personId);
    expect(refreshClaims.jti).toBe(refreshJti);
  });

  it('cfp_claim token is not accepted by verifyAccess', async () => {
    const claimToken = await new SignJWT({ sub: 'gh-123', scope: 'claim', candidates: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JWT_KEY));

    await expect(verifyAccess(claimToken, JWT_KEY)).rejects.toThrow('scope mismatch');
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — shared app (no mutations needed)
// ---------------------------------------------------------------------------

describe('GET /api/auth/me', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  const personId = '01951a3c-0000-7000-8000-000000000099';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'me-test-person', personId);
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('returns anonymous when no cookie is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ success: boolean; data: { person: null; accountLevel: string } }>();
    expect(body.success).toBe(true);
    expect(body.data.person).toBeNull();
    expect(body.data.accountLevel).toBe('anonymous');
  });

  it('returns person + accountLevel with valid cfp_session cookie', async () => {
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { cfp_session: accessToken },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      data: { person: { id: string; slug: string } | null; accountLevel: string };
    }>();
    expect(body.success).toBe(true);
    expect(body.data.accountLevel).toBe('user');
    expect(body.data.person?.id).toBe(personId);
    expect(body.data.person?.slug).toBe('me-test-person');
  });

  it('returns anonymous when access JWT is expired', async () => {
    const expiredToken = await new SignJWT({
      sub: personId,
      jti: 'test-expired-jti',
      accountLevel: 'user',
      scope: 'session',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(JWT_KEY));

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { cfp_session: expiredToken },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { person: null; accountLevel: string } }>();
    expect(body.data.person).toBeNull();
    expect(body.data.accountLevel).toBe('anonymous');
  });
});

// ---------------------------------------------------------------------------
// OAuth stubs — shared app
// ---------------------------------------------------------------------------

describe('OAuth stub endpoints', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('GET /api/auth/github/start returns 501 oauth_not_yet_wired', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/github/start' });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('oauth_not_yet_wired');
  });

  it('GET /api/auth/github/callback returns 501 oauth_not_yet_wired', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/github/callback' });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('oauth_not_yet_wired');
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/refresh — shared app
// ---------------------------------------------------------------------------

describe('POST /api/auth/refresh', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  const personId = '01951a3c-0000-7000-8000-000000000002';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'refresh-test-person', personId);
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('returns 401 no_refresh_token when cfp_refresh cookie is absent', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh' });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('no_refresh_token');
  });

  it('returns 401 refresh_token_expired when cookie is expired', async () => {
    const expiredRefresh = await new SignJWT({
      sub: personId,
      jti: 'refresh-jti',
      scope: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 100)
      .sign(new TextEncoder().encode(JWT_KEY));

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { cfp_refresh: expiredRefresh },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('refresh_token_expired');
  });

  it('returns 401 refresh_token_revoked when jti is revoked', async () => {
    const { refreshToken, refreshJti } = await mintSessionFor(personId, 'user', JWT_KEY);

    await app.revocations.revoke(
      { jti: refreshJti, personId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      app.store.public,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { cfp_refresh: refreshToken },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('refresh_token_revoked');
  });

  it('returns new pair with valid refresh JWT', async () => {
    const { accessToken, refreshToken, refreshJti } = await mintSessionFor(personId, 'user', JWT_KEY);

    // Add session metadata so the endpoint can store the new session
    await app.sessionMetadata.add(
      {
        refreshJti,
        personId,
        userAgent: 'test',
        ipAddress: '127.0.0.1',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      app.store.private,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { cfp_session: accessToken, cfp_refresh: refreshToken },
    });

    expect(res.statusCode).toBe(200);

    const setCookies = res.headers['set-cookie'];
    const cookiesArr = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
    const hasSession = cookiesArr.some((c) => c.startsWith('cfp_session=') && !c.startsWith('cfp_session=;'));
    const hasRefresh = cookiesArr.some((c) => c.startsWith('cfp_refresh=') && !c.startsWith('cfp_refresh=;'));
    expect(hasSession).toBe(true);
    expect(hasRefresh).toBe(true);

    // Old refresh jti should now be revoked
    expect(app.revocations.isRevoked(refreshJti)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout — each test needs isolation (state mutations)
// ---------------------------------------------------------------------------

describe('POST /api/auth/logout', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  const personId = '01951a3c-0000-7000-8000-000000000003';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('clears cookies and returns 204', async () => {
    const { accessToken, refreshToken } = await mintSessionFor(personId, 'user', JWT_KEY);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { cfp_session: accessToken, cfp_refresh: refreshToken },
    });

    expect(res.statusCode).toBe(204);

    const setCookieHeaders = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookieHeaders)
      ? setCookieHeaders.join('; ')
      : String(setCookieHeaders ?? '');
    expect(cookieStr).toContain('cfp_session=;');
    expect(cookieStr).toContain('cfp_refresh=;');
  });

  it('subsequent /api/auth/me after logout returns anonymous', async () => {
    const personId2 = '01951a3c-0000-7000-8000-000000000004';
    const { accessToken, refreshToken } = await mintSessionFor(personId2, 'user', JWT_KEY);

    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { cfp_session: accessToken, cfp_refresh: refreshToken },
    });

    // The access jti should now be in the revocations set
    // /api/auth/me with the same cookie should return anonymous
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { cfp_session: accessToken },
    });

    expect(meRes.statusCode).toBe(200);
    const body = meRes.json<{ data: { person: unknown; accountLevel: string } }>();
    expect(body.data.person).toBeNull();
    expect(body.data.accountLevel).toBe('anonymous');
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/sessions + POST /api/auth/sessions/:jti/revoke
// ---------------------------------------------------------------------------

describe('session management', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  const personId = '01951a3c-0000-7000-8000-000000000005';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'sessions-test-person', personId);
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('GET /api/auth/sessions returns 401 when not authenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/auth/sessions lists non-revoked sessions with current:true', async () => {
    const { accessToken, refreshToken, refreshJti } = await mintSessionFor(personId, 'user', JWT_KEY);

    await app.sessionMetadata.add(
      {
        refreshJti,
        personId,
        userAgent: 'Test Browser',
        ipAddress: '127.0.0.1',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      app.store.private,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      cookies: { cfp_session: accessToken, cfp_refresh: refreshToken },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        jti: string;
        userAgent: string;
        ipAddress: string;
        issuedAt: string;
        expiresAt: string;
        current: boolean;
      }>;
    }>();

    expect(Array.isArray(body.data)).toBe(true);
    const current = body.data.find((s) => s.jti === refreshJti);
    expect(current).toBeDefined();
    expect(current?.current).toBe(true);
    expect(current?.userAgent).toBe('Test Browser');
  });

  it('POST /api/auth/sessions/:jti/revoke with current jti → 409 cannot_revoke_current_session', async () => {
    const { accessToken, refreshToken, refreshJti } = await mintSessionFor(personId, 'user', JWT_KEY);

    await app.sessionMetadata.add(
      {
        refreshJti,
        personId,
        userAgent: 'Test Browser',
        ipAddress: '127.0.0.1',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      app.store.private,
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/auth/sessions/${refreshJti}/revoke`,
      cookies: { cfp_session: accessToken, cfp_refresh: refreshToken },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('cannot_revoke_current_session');
  });

  it('POST /api/auth/sessions/:jti/revoke with nonexistent jti → 404', async () => {
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sessions/nonexistent-jti/revoke',
      cookies: { cfp_session: accessToken },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Account-based rate limits
// ---------------------------------------------------------------------------

describe('account-based rate limits', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  const personId = '01951a3c-0000-7000-8000-000000000006';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'ratelimit-test-person', personId);
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('authenticated reads key on account bucket (300/min), separate from IP bucket', async () => {
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);

    // Exhaust the IP bucket with anonymous reads (60 limit)
    for (let i = 0; i < 60; i++) {
      await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '10.99.0.1' });
    }

    // 61st anonymous request → 429
    const anonRes = await app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '10.99.0.1',
    });
    expect(anonRes.statusCode).toBe(429);

    // Authenticated request from the same IP → uses account bucket (fresh), should succeed
    const authRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      remoteAddress: '10.99.0.1',
      cookies: { cfp_session: accessToken },
    });
    expect(authRes.statusCode).toBe(200);
  });
});
