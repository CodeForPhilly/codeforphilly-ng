/**
 * Tests for `POST /api/auth/link-github` + the GitHub callback's
 * link-mode branch per specs/api/auth.md and
 * specs/behaviors/account-migration.md.
 *
 * Two scenarios:
 *   1. Initiate link — auth-required, fast-fail when already linked,
 *      happy path issues a link-mode oauth-session cookie and 302s to
 *      GitHub.
 *   2. Callback link-mode — happy path mutates Person.githubUserId,
 *      conflict cases redirect to /account?error=<code>.
 *
 * Each test uses a unique remoteAddress so the 10-req/min/IP cap on
 * /api/auth/* doesn't cross-contaminate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth/jwt.js';
import { verifyOAuthSession } from '../src/auth/oauth-session-cookie.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';
import { createGitHubMock } from './helpers/mocks.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const GH_CLIENT_ID = 'test-client-id';
const GH_CLIENT_SECRET = 'test-client-secret';

let testIpCounter = 0;
function nextTestIp(): string {
  testIpCounter += 1;
  return `10.7.${Math.floor(testIpCounter / 250)}.${testIpCounter % 250}`;
}

interface SeedPersonOpts {
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
    `accountLevel = "user"`,
    `createdAt = "2026-05-01T00:00:00Z"`,
    `updatedAt = "2026-05-01T00:00:00Z"`,
  ];
  if (opts.githubUserId !== undefined) lines.push(`githubUserId = ${opts.githubUserId}`);
  if (opts.githubLogin !== undefined) lines.push(`githubLogin = "${opts.githubLogin}"`);
  if (opts.githubLinkedAt !== undefined) lines.push(`githubLinkedAt = "${opts.githubLinkedAt}"`);
  await seedRawToml(repoDir, `people/${slug}.toml`, lines.join('\n'), `seed person ${slug}`);
}

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
    // first write
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

describe('POST /api/auth/link-github', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const unlinkedPersonId = '01951a3c-0000-7000-8000-0000ddddddd1';
  const linkedPersonId = '01951a3c-0000-7000-8000-0000ddddddd2';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'unlinked-user', unlinkedPersonId);
    await seedPrivateProfile(privateStore.path, unlinkedPersonId, 'unlinked@example.com');
    await seedPerson(dataRepo.path, 'already-linked', linkedPersonId, {
      githubUserId: 4242,
      githubLogin: 'already-linked-gh',
      githubLinkedAt: '2026-04-01T00:00:00Z',
    });
    await seedPrivateProfile(privateStore.path, linkedPersonId, 'linked@example.com');
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('returns 401 unauthenticated when no session cookie is present', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/link-github',
      remoteAddress: nextTestIp(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('redirects to /account?error=github_already_linked when the caller already has a GitHub link', async () => {
    const { access } = await issueSession(linkedPersonId, 'user', JWT_KEY, {
      loginMethod: 'github',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/link-github',
      remoteAddress: nextTestIp(),
      cookies: { cfp_session: access },
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toBe('/account?error=github_already_linked');
  });

  it('sets link-mode oauth-session cookie + state cookie + 302s to GitHub authorize', async () => {
    const { access } = await issueSession(unlinkedPersonId, 'user', JWT_KEY, {
      loginMethod: 'legacy_password',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/link-github',
      remoteAddress: nextTestIp(),
      cookies: { cfp_session: access },
    });
    expect(res.statusCode).toBe(302);
    const location = String(res.headers['location']);
    expect(location.startsWith('https://github.com/login/oauth/authorize')).toBe(true);

    const setCookies = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
    const stateCookie = cookies.find((c) => c.startsWith('cfp_oauth_state='));
    const sessionCookie = cookies.find((c) => c.startsWith('cfp_oauth_session='));
    expect(stateCookie).toBeDefined();
    expect(sessionCookie).toBeDefined();

    const sessionValue = sessionCookie!.split(';')[0]!.replace('cfp_oauth_session=', '');
    const claims = await verifyOAuthSession(sessionValue, JWT_KEY);
    expect(claims.mode).toBe('link');
    expect(claims.linkPersonId).toBe(unlinkedPersonId);
    expect(claims.return).toBe('/account');
  });
});

// Helper for the callback tests below: drive a real link-mode start flow
// so the cookies + state + verifier are all consistent with what the route
// expects.
async function startLinkFlow(
  app: FastifyInstance,
  personId: string,
  ip: string,
): Promise<{ state: string; stateCookie: string; oauthSessionCookie: string }> {
  const { access } = await issueSession(personId, 'user', JWT_KEY, {
    loginMethod: 'legacy_password',
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/link-github',
    remoteAddress: ip,
    cookies: { cfp_session: access },
  });
  if (res.statusCode !== 302) {
    throw new Error(`startLinkFlow: expected 302, got ${res.statusCode}`);
  }
  const url = new URL(String(res.headers['location']));
  const state = url.searchParams.get('state');
  const setCookies = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
  const stateCookie = cookies.find((c) => c.startsWith('cfp_oauth_state='))!;
  const sessionCookie = cookies.find((c) => c.startsWith('cfp_oauth_session='))!;
  return {
    state: state!,
    stateCookie: stateCookie.split(';')[0]!.replace('cfp_oauth_state=', ''),
    oauthSessionCookie: sessionCookie.split(';')[0]!.replace('cfp_oauth_session=', ''),
  };
}

describe('GET /api/auth/github/callback — link mode', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const mock = createGitHubMock();
  const linkingPersonId = '01951a3c-0000-7000-8000-0000eeeeeee1';
  const otherPersonId = '01951a3c-0000-7000-8000-0000eeeeeee2';

  beforeAll(async () => {
    mock.server.listen({ onUnhandledRequest: 'error' });
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    // Person doing the linking — has a legacy credential, no GitHub link.
    await seedPerson(dataRepo.path, 'linking-user', linkingPersonId);
    await seedPrivateProfile(privateStore.path, linkingPersonId, 'linking@example.com');
    // Another Person already bound to GitHub id 55555 — collision target.
    await seedPerson(dataRepo.path, 'other-user', otherPersonId, {
      githubUserId: 55555,
      githubLogin: 'someone-else-gh',
      githubLinkedAt: '2026-04-01T00:00:00Z',
    });
    await seedPrivateProfile(privateStore.path, otherPersonId, 'other@example.com');

    app = await buildTestApp(dataRepo.path, privateStore.path);

    mock.setTokenResponse({
      access_token: 'gho_link_test',
      token_type: 'bearer',
      scope: 'read:user,user:email',
    });
  }, 60_000);

  afterAll(async () => {
    mock.server.close();
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('redirects /account?error=github_id_in_use_elsewhere when gh.id is bound to a different Person', async () => {
    mock.setGitHubUser({ id: 55555, login: 'someone-else-gh', name: 'Other', avatar_url: 'x' });
    mock.setGitHubEmails([
      { email: 'other@example.com', primary: true, verified: true, visibility: 'public' },
    ]);
    const ip = nextTestIp();
    const flow = await startLinkFlow(app, linkingPersonId, ip);
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
    expect(String(res.headers['location'])).toBe('/account?error=github_id_in_use_elsewhere');
    // Did NOT mutate the linking Person
    const person = app.inMemoryState.people.get(linkingPersonId);
    expect(person?.githubUserId).toBeUndefined();
  });

  it('links the calling Person to GitHub and redirects /account?linked=github', async () => {
    mock.setGitHubUser({ id: 77777, login: 'linking-user-gh', name: 'Linking User', avatar_url: 'x' });
    mock.setGitHubEmails([
      { email: 'linking-gh@example.com', primary: true, verified: true, visibility: 'public' },
    ]);
    const ip = nextTestIp();
    const flow = await startLinkFlow(app, linkingPersonId, ip);
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
    expect(String(res.headers['location'])).toBe('/account?linked=github');

    // Person mutated: gh fields populated
    const person = app.inMemoryState.people.get(linkingPersonId);
    expect(person?.githubUserId).toBe(77777);
    expect(person?.githubLogin).toBe('linking-user-gh');
    expect(person?.githubLinkedAt).toBeDefined();

    // PrivateProfile email NOT auto-refreshed (deferred in v1)
    const profile = await app.store.private.getProfile(linkingPersonId);
    expect(profile?.email).toBe('linking@example.com');

    // No new session cookies — the user was already signed-in.
    const setCookies = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
    const newSession = cookies.find(
      (c) => c.startsWith('cfp_session=') && !c.startsWith('cfp_session=;'),
    );
    expect(newSession).toBeUndefined();
  });
});
