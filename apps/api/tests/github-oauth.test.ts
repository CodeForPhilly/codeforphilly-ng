/**
 * Tests for the github-oauth plan validation criteria.
 *
 * Covers each callback outcome:
 *   - existing-linked → refresh + session
 *   - create-fresh    → new Person + PrivateProfile + session
 *   - candidates      → claim-pending JWT + redirect to /account-claim
 * And the documented error modes:
 *   - access_denied (GitHub error param)
 *   - oauth_state_mismatch (CSRF)
 *   - oauth_session_invalid (signed cookie tampered/expired)
 *   - email_unverified
 *   - github_unreachable (PKCE / token error)
 *
 * Each test uses a unique remoteAddress so the 10-req/min/IP cap on
 * /api/auth/* doesn't cause one test's setup to fail another test's run.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SignJWT } from 'jose';

import { buildApp } from '../src/app.js';
import { verifyAccess, verifyRefresh, verifyClaimPending } from '../src/auth/jwt.js';
import { verifyOAuthSession } from '../src/auth/oauth-session-cookie.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';
import { createGitHubMock } from './helpers/mocks.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const GH_CLIENT_ID = 'test-client-id';
const GH_CLIENT_SECRET = 'test-client-secret';

interface SeedPersonOpts {
  readonly accountLevel?: 'user' | 'staff' | 'administrator';
  readonly githubUserId?: number;
  readonly githubLogin?: string;
  readonly githubLinkedAt?: string;
}

async function seedPerson(
  repoDir: string,
  slug: string,
  id: string,
  opts: SeedPersonOpts = {},
): Promise<void> {
  const lines = [
    `id = "${id}"`,
    `slug = "${slug}"`,
    `fullName = "Test ${slug}"`,
    `accountLevel = "${opts.accountLevel ?? 'user'}"`,
    `createdAt = "2026-05-01T00:00:00Z"`,
    `updatedAt = "2026-05-01T00:00:00Z"`,
  ];
  if (opts.githubUserId !== undefined) {
    lines.push(`githubUserId = ${opts.githubUserId}`);
  }
  if (opts.githubLogin !== undefined) {
    lines.push(`githubLogin = "${opts.githubLogin}"`);
  }
  if (opts.githubLinkedAt !== undefined) {
    lines.push(`githubLinkedAt = "${opts.githubLinkedAt}"`);
  }

  await seedRawToml(repoDir, `people/${slug}.toml`, lines.join('\n'), `seed person ${slug}`);
}

/** Seed a PrivateProfile directly into the filesystem private store. */
async function seedPrivateProfile(
  privatePath: string,
  personId: string,
  email: string,
): Promise<void> {
  const filePath = join(privatePath, 'profiles.jsonl');
  const profile = {
    personId,
    email: email.toLowerCase(),
    emailRefreshedAt: '2026-05-01T00:00:00Z',
    newsletter: null,
    updatedAt: '2026-05-01T00:00:00Z',
  };
  let content = '';
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    // file doesn't exist yet
  }
  await writeFile(filePath, content + JSON.stringify(profile) + '\n');
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
      GITHUB_OAUTH_CLIENT_ID: GH_CLIENT_ID,
      GITHUB_OAUTH_CLIENT_SECRET: GH_CLIENT_SECRET,
      NODE_ENV: 'test',
    },
  });
}

interface StartedFlow {
  readonly state: string;
  readonly oauthSessionCookie: string;
  readonly stateCookie: string;
}

// Each test that hits /api/auth/* uses a unique remoteAddress to dodge the
// 10-req/min/IP cap on auth endpoints (shared across the suite's lifetime).
let testIpCounter = 0;
function nextTestIp(): string {
  testIpCounter += 1;
  return `10.0.${Math.floor(testIpCounter / 250)}.${testIpCounter % 250}`;
}

async function startFlow(
  app: FastifyInstance,
  returnPath: string,
  remoteAddress: string,
): Promise<StartedFlow> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/auth/github/start?return=${encodeURIComponent(returnPath)}`,
    remoteAddress,
  });
  expect(res.statusCode).toBe(302);

  const location = res.headers['location'];
  expect(typeof location).toBe('string');
  const url = new URL(String(location));
  expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');

  const state = url.searchParams.get('state');
  expect(state).toBeTruthy();

  const setCookies = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
  const stateCookie = cookies.find((c) => c.startsWith('cfp_oauth_state='));
  const sessionCookie = cookies.find((c) => c.startsWith('cfp_oauth_session='));
  expect(stateCookie).toBeDefined();
  expect(sessionCookie).toBeDefined();

  const stateValue = stateCookie!.split(';')[0]!.replace('cfp_oauth_state=', '');
  const sessionValue = sessionCookie!.split(';')[0]!.replace('cfp_oauth_session=', '');

  return {
    state: state!,
    stateCookie: stateValue,
    oauthSessionCookie: sessionValue,
  };
}

// ---------------------------------------------------------------------------
// GET /api/auth/github/start
// ---------------------------------------------------------------------------

describe('GET /api/auth/github/start', () => {
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

  it('redirects to github with state + PKCE challenge + correct scopes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/github/start',
      remoteAddress: nextTestIp(),
    });
    expect(res.statusCode).toBe(302);
    const url = new URL(String(res.headers['location']));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(GH_CLIENT_ID);
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = url.searchParams.get('code_challenge');
    expect(challenge).toBeTruthy();
    expect(challenge!.length).toBeGreaterThan(20);
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
  });

  it('sets cfp_oauth_state and cfp_oauth_session cookies with HttpOnly + SameSite=Lax', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/github/start',
      remoteAddress: nextTestIp(),
    });
    const setCookies = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
    const stateCookie = cookies.find((c) => c.startsWith('cfp_oauth_state='));
    const sessionCookie = cookies.find((c) => c.startsWith('cfp_oauth_session='));
    expect(stateCookie).toContain('HttpOnly');
    expect(stateCookie?.toLowerCase()).toContain('samesite=lax');
    expect(stateCookie).toContain('Path=/api/auth');
    expect(sessionCookie).toContain('HttpOnly');
  });

  it('signed oauth session cookie carries the state, verifier, and return path', async () => {
    const flow = await startFlow(app, '/projects/foo', nextTestIp());
    const claims = await verifyOAuthSession(flow.oauthSessionCookie, JWT_KEY);
    expect(claims.state).toBe(flow.state);
    expect(claims.codeVerifier.length).toBeGreaterThan(20);
    expect(claims.return).toBe('/projects/foo');
  });

  it('ignores cross-origin return values and falls back to "/"', async () => {
    const flow = await startFlow(app, 'https://evil.example.com/', nextTestIp());
    const claims = await verifyOAuthSession(flow.oauthSessionCookie, JWT_KEY);
    expect(claims.return).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// /github/callback — error scenarios
// ---------------------------------------------------------------------------

describe('GET /api/auth/github/callback — error scenarios', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const mock = createGitHubMock();

  beforeAll(async () => {
    mock.server.listen({ onUnhandledRequest: 'error' });
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterEach(() => {
    mock.server.resetHandlers();
  });

  afterAll(async () => {
    mock.server.close();
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('redirects to /login?error=access_denied when GitHub passes back error=access_denied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/github/callback?error=access_denied&error_description=user+declined',
      remoteAddress: nextTestIp(),
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/login?error=access_denied');
  });

  it('redirects to /login?error=oauth_state_mismatch when state cookie is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/github/callback?code=abc&state=tampered',
      remoteAddress: nextTestIp(),
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/login?error=oauth_state_mismatch');
  });

  it('redirects to /login?error=oauth_state_mismatch when query state does not match cookie', async () => {
    const ip = nextTestIp();
    const flow = await startFlow(app, '/', ip);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=different-state`,
      remoteAddress: ip,
      cookies: {
        cfp_oauth_state: flow.stateCookie,
        cfp_oauth_session: flow.oauthSessionCookie,
      },
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/login?error=oauth_state_mismatch');
  });

  it('redirects to /login?error=oauth_session_invalid when signed session cookie is bogus', async () => {
    const ip = nextTestIp();
    const flow = await startFlow(app, '/', ip);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      remoteAddress: ip,
      cookies: {
        cfp_oauth_state: flow.stateCookie,
        cfp_oauth_session: 'not-a-jwt',
      },
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/login?error=oauth_session_invalid');
  });

  it('redirects to /login?error=oauth_session_invalid when signed session cookie is expired', async () => {
    const ip = nextTestIp();
    const flow = await startFlow(app, '/', ip);
    const expiredSession = await new SignJWT({
      state: flow.state,
      codeVerifier: 'whatever',
      return: '/',
      scope: 'oauth_session',
      jti: 'expired',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(JWT_KEY));

    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      remoteAddress: ip,
      cookies: {
        cfp_oauth_state: flow.stateCookie,
        cfp_oauth_session: expiredSession,
      },
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/login?error=oauth_session_invalid');
  });

  it('redirects to /login?error=email_unverified when GitHub returns no verified email', async () => {
    mock.setGitHubUser({ id: 4242, login: 'noemailuser', name: 'No Email User', avatar_url: 'x' });
    mock.setGitHubEmails([
      { email: 'noemail@example.com', primary: true, verified: false, visibility: null },
    ]);
    const ip = nextTestIp();
    const flow = await startFlow(app, '/', ip);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      remoteAddress: ip,
      cookies: {
        cfp_oauth_state: flow.stateCookie,
        cfp_oauth_session: flow.oauthSessionCookie,
      },
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/login?error=email_unverified');
  });

  it('redirects to /login?error=github_unreachable when token exchange errors', async () => {
    mock.setTokenResponse({ error: 'bad_verification_code' });
    const ip = nextTestIp();
    const flow = await startFlow(app, '/', ip);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      remoteAddress: ip,
      cookies: {
        cfp_oauth_state: flow.stateCookie,
        cfp_oauth_session: flow.oauthSessionCookie,
      },
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/login?error=github_unreachable');
  });
});

// ---------------------------------------------------------------------------
// /github/callback — happy paths
// ---------------------------------------------------------------------------

describe('GET /api/auth/github/callback — existing-linked outcome', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const mock = createGitHubMock();
  const personId = '01951a3c-0000-7000-8000-0000aaaaaaa1';

  beforeAll(async () => {
    mock.server.listen({ onUnhandledRequest: 'error' });
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'linked-user', personId, {
      githubUserId: 12345,
      githubLogin: 'linked-user-old-login',
      githubLinkedAt: '2026-04-01T00:00:00Z',
    });
    await seedPrivateProfile(privateStore.path, personId, 'old@example.com');
    app = await buildTestApp(dataRepo.path, privateStore.path);

    mock.setGitHubUser({ id: 12345, login: 'linked-user-new', name: 'Linked User', avatar_url: 'x' });
    mock.setGitHubEmails([
      { email: 'new@example.com', primary: true, verified: true, visibility: 'public' },
    ]);
    mock.setTokenResponse({ access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' });
  }, 60_000);

  afterAll(async () => {
    mock.server.close();
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('matches by githubUserId, refreshes login + email, issues session, redirects to return path', async () => {
    const ip = nextTestIp();
    const flow = await startFlow(app, '/projects', ip);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      remoteAddress: ip,
      cookies: {
        cfp_oauth_state: flow.stateCookie,
        cfp_oauth_session: flow.oauthSessionCookie,
      },
    });

    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/projects');

    const setCookies = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
    const session = cookies.find((c) => c.startsWith('cfp_session=') && !c.startsWith('cfp_session=;'));
    const refresh = cookies.find((c) => c.startsWith('cfp_refresh=') && !c.startsWith('cfp_refresh=;'));
    expect(session).toBeDefined();
    expect(refresh).toBeDefined();

    const accessValue = session!.split(';')[0]!.replace('cfp_session=', '');
    const claims = await verifyAccess(accessValue, JWT_KEY);
    expect(claims.sub).toBe(personId);

    const person = app.inMemoryState.people.get(personId);
    expect(person?.githubLogin).toBe('linked-user-new');

    const profile = await app.store.private.getProfile(personId);
    expect(profile?.email).toBe('new@example.com');

    const refreshValue = refresh!.split(';')[0]!.replace('cfp_refresh=', '');
    const refreshClaims = await verifyRefresh(refreshValue, JWT_KEY);
    const meta = app.sessionMetadata.get(refreshClaims.jti);
    expect(meta?.personId).toBe(personId);
  });
});

describe('GET /api/auth/github/callback — fresh user outcome', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const mock = createGitHubMock();

  beforeAll(async () => {
    mock.server.listen({ onUnhandledRequest: 'error' });
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    app = await buildTestApp(dataRepo.path, privateStore.path);

    mock.setGitHubUser({ id: 99999, login: 'brand-new-user', name: 'Brand New', avatar_url: 'x' });
    mock.setGitHubEmails([
      { email: 'brand-new@example.com', primary: true, verified: true, visibility: 'public' },
    ]);
    mock.setTokenResponse({ access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' });
  }, 60_000);

  afterAll(async () => {
    mock.server.close();
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('creates Person + PrivateProfile, issues session, redirects to return path', async () => {
    const ip = nextTestIp();
    const flow = await startFlow(app, '/', ip);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      remoteAddress: ip,
      cookies: {
        cfp_oauth_state: flow.stateCookie,
        cfp_oauth_session: flow.oauthSessionCookie,
      },
    });

    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/');

    const person = [...app.inMemoryState.people.values()].find((p) => p.githubUserId === 99999);
    expect(person).toBeDefined();
    expect(person?.slug).toBe('brand-new-user');
    expect(person?.fullName).toBe('Brand New');
    expect(person?.githubLogin).toBe('brand-new-user');
    expect(person?.githubLinkedAt).toBeDefined();
    expect(person?.slackSamlNameId).toBe('brand-new-user');

    const profile = await app.store.private.getProfile(person!.id);
    expect(profile?.email).toBe('brand-new@example.com');

    const setCookies = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
    const session = cookies.find((c) => c.startsWith('cfp_session=') && !c.startsWith('cfp_session=;'));
    expect(session).toBeDefined();

    const accessValue = session!.split(';')[0]!.replace('cfp_session=', '');
    const claims = await verifyAccess(accessValue, JWT_KEY);
    expect(claims.sub).toBe(person!.id);
  });

  it('fires the welcome notification with the new person + email', async () => {
    const ip = nextTestIp();
    const flow = await startFlow(app, '/', ip);

    // Spy on the boot-installed LoggingNotifier (no Resend in tests).
    // The notifier call is fire-and-forget — we await the OAuth response
    // first, then assert the spy. The notifier's spawn is synchronous up
    // to the await inside it, so it's guaranteed to have been called by
    // the time the route handler returns.
    mock.setGitHubUser({
      id: 88888,
      login: 'welcome-target',
      name: 'Welcome Target',
      avatar_url: 'x',
    });
    mock.setGitHubEmails([
      { email: 'welcome-target@example.com', primary: true, verified: true, visibility: 'public' },
    ]);

    const spy = vi.spyOn(app.notifier, 'notifyWelcomeOnSignup');

    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      remoteAddress: ip,
      cookies: {
        cfp_oauth_state: flow.stateCookie,
        cfp_oauth_session: flow.oauthSessionCookie,
      },
    });
    expect(res.statusCode).toBe(302);
    expect(spy).toHaveBeenCalledWith({
      email: 'welcome-target@example.com',
      fullName: 'Welcome Target',
      slug: 'welcome-target',
    });
    spy.mockRestore();
  });
});

describe('GET /api/auth/github/callback — candidates outcome', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const mock = createGitHubMock();
  const candidateId = '01951a3c-0000-7000-8000-0000bbbbbbb1';

  beforeAll(async () => {
    mock.server.listen({ onUnhandledRequest: 'error' });
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'legacy-jane', candidateId);
    await seedPrivateProfile(privateStore.path, candidateId, 'jane@example.com');
    app = await buildTestApp(dataRepo.path, privateStore.path);

    mock.setGitHubUser({ id: 7777, login: 'jane-on-github', name: 'Jane', avatar_url: 'x' });
    mock.setGitHubEmails([
      { email: 'jane@example.com', primary: true, verified: true, visibility: 'public' },
    ]);
    mock.setTokenResponse({ access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' });
  }, 60_000);

  afterAll(async () => {
    mock.server.close();
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('issues claim-pending JWT and redirects to /account-claim with return path', async () => {
    const ip = nextTestIp();
    const flow = await startFlow(app, '/help-wanted', ip);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      remoteAddress: ip,
      cookies: {
        cfp_oauth_state: flow.stateCookie,
        cfp_oauth_session: flow.oauthSessionCookie,
      },
    });

    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/account-claim?return=%2Fhelp-wanted');

    const setCookies = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
    const claim = cookies.find((c) => c.startsWith('cfp_claim='));
    expect(claim).toBeDefined();
    expect(claim).toContain('Path=/api/account-claim');
    const session = cookies.find((c) => c.startsWith('cfp_session=') && !c.startsWith('cfp_session=;'));
    expect(session).toBeUndefined();

    const claimValue = claim!.split(';')[0]!.replace('cfp_claim=', '');
    const claims = await verifyClaimPending(claimValue, JWT_KEY);
    expect(claims.scope).toBe('claim');
    expect(claims.sub).toBe('7777');
    expect(claims.ghLogin).toBe('jane-on-github');
    expect(claims.candidates).toContain(candidateId);
    expect(claims.ghEmails).toContain('jane@example.com');

    const candidate = app.inMemoryState.people.get(candidateId);
    expect(candidate?.githubUserId).toBeUndefined();
  });
});

describe('GET /api/auth/github/callback — username weak match contributes to candidates', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const mock = createGitHubMock();
  const candidateId = '01951a3c-0000-7000-8000-0000ccccccc1';

  beforeAll(async () => {
    mock.server.listen({ onUnhandledRequest: 'error' });
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    // Person whose slug == gh.login, no email overlap
    await seedPerson(dataRepo.path, 'username-match', candidateId);
    await seedPrivateProfile(privateStore.path, candidateId, 'someoneelse@example.com');
    app = await buildTestApp(dataRepo.path, privateStore.path);

    mock.setGitHubUser({ id: 8888, login: 'username-match', name: 'U M', avatar_url: 'x' });
    mock.setGitHubEmails([
      { email: 'unrelated@example.com', primary: true, verified: true, visibility: 'public' },
    ]);
    mock.setTokenResponse({ access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' });
  }, 60_000);

  afterAll(async () => {
    mock.server.close();
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('username match yields a candidate even without email overlap', async () => {
    const ip = nextTestIp();
    const flow = await startFlow(app, '/', ip);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      remoteAddress: ip,
      cookies: {
        cfp_oauth_state: flow.stateCookie,
        cfp_oauth_session: flow.oauthSessionCookie,
      },
    });

    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/account-claim?return=%2F');

    const setCookies = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
    const claim = cookies.find((c) => c.startsWith('cfp_claim='));
    const claimValue = claim!.split(';')[0]!.replace('cfp_claim=', '');
    const claims = await verifyClaimPending(claimValue, JWT_KEY);
    expect(claims.candidates).toContain(candidateId);
  });
});
