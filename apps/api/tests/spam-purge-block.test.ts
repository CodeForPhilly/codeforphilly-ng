/**
 * The re-registration block and the purge log — specs/api/auth.md ("Purged as
 * spam", `signup_blocked`, `github_blocked`), specs/api/people.md (purge
 * `{ spam, reason }`), specs/api/moderation.md (`GET /api/admin/spam-purges`,
 * `POST …/unblock`), specs/behaviors/person-lifecycle.md (the sweep writes
 * `spam-purges`).
 *
 * Case 1 of the plan: a purged GitHub account signed straight back up, got the
 * same slug, and the earlier account's staff vote showed as its own.
 */
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { issueSession } from '../src/auth/jwt.js';
import {
  JWT_KEY,
  bearer,
  createAgent,
  daysAgo,
  fid,
  personRecord,
  privateProfile,
  startAgentTestEnv,
  type AgentTestEnv,
  type Rec,
} from './helpers/agent-fixtures.js';
import { createGitHubMock } from './helpers/mocks.js';

const ADMIN = 1;
const STAFF = 2;
const USER = 3;
const LINKER = 4;
const N = { blocked: 10, spamPurged: 11, erased: 12, swept: 13, restored: 14 };
const GH = { blocked: 31_001, purgedByStaff: 31_002, erased: 31_003, swept: 31_004, restored: 31_005 };
const OLD_PURGE_ID = fid(900);
const RESTORED_PURGE_ID = fid(901);

let ipCounter = 0;
const nextIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

const oldPurge: Rec = {
  id: OLD_PURGE_ID,
  personSlug: 'promo-shop',
  personId: fid(800),
  githubUserId: GH.blocked,
  purgedAt: daysAgo(2),
  by: 'human-staffer',
  reason: 'Promotional bio.',
  flags: [],
  evidence: [],
  beforeCommit: '0123456789abcdef0123456789abcdef01234567',
  blocksSignIn: true,
};

describe('spam purges block re-sign-up', () => {
  let env: AgentTestEnv;
  let admin: string;
  let staff: string;
  let user: string;
  const mock = createGitHubMock();

  beforeAll(async () => {
    mock.server.listen({ onUnhandledRequest: 'error' });
    // The roster's GitHub re-probe (OAuth app configured): every account is "gone".
    mock.server.use(http.get(/^https:\/\/api\.github\.com\/user\/\d+$/, () => new HttpResponse(null, { status: 404 })));
    env = await startAgentTestEnv({
      env: { GITHUB_OAUTH_CLIENT_ID: 'test-client-id', GITHUB_OAUTH_CLIENT_SECRET: 'test-client-secret' },
      records: {
        people: [
          personRecord(ADMIN, 'boss', { accountLevel: 'administrator' }),
          personRecord(STAFF, 'staffer', { accountLevel: 'staff' }),
          personRecord(USER, 'regular'),
          personRecord(LINKER, 'linker', { createdAt: daysAgo(100) }),
          personRecord(N.spamPurged, 'staff-target', { createdAt: daysAgo(1), githubUserId: GH.purgedByStaff, bio: 'Deals deals deals' }),
          personRecord(N.erased, 'erase-me', { createdAt: daysAgo(400), githubUserId: GH.erased }),
          personRecord(N.swept, 'swept', { createdAt: daysAgo(10), deletedAt: daysAgo(5), githubUserId: GH.swept }),
          // Purged as spam, then restored by staff: the live record holds the id.
          personRecord(N.restored, 'restored', { createdAt: daysAgo(30), githubUserId: GH.restored, githubLogin: 'restored' }),
        ],
        'spam-purges': [
          oldPurge,
          { ...oldPurge, id: RESTORED_PURGE_ID, personSlug: 'restored', personId: fid(N.restored), githubUserId: GH.restored },
        ],
        'person-evaluations': [
          // The earlier promo-shop account's staff vote, before the purge.
          { personSlug: 'promo-shop', evaluator: 'human-staffer', verdict: 'spam', confidence: 1, flags: ['manual-override'], reasoning: 'Promo bio', evaluatedAt: daysAgo(2.1) },
          { personSlug: 'swept', evaluator: 'human-boss', verdict: 'spam', confidence: 1, flags: ['manual-override'], evaluatedAt: daysAgo(4) },
        ],
      },
      profiles: [
        privateProfile(fid(LINKER), 'linker@example.org'),
        privateProfile(fid(N.restored), 'restored@example.org'),
      ],
    });
    admin = await env.cookie(ADMIN, 'administrator');
    staff = await env.cookie(STAFF, 'staff');
    user = await env.cookie(USER, 'user');
    mock.setTokenResponse({ access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' });
  }, 90_000);

  afterAll(async () => {
    mock.server.close();
    await env.close();
  });

  const head = async () => (await env.git('rev-parse', 'HEAD')).trim();

  async function githubCallback(ghId: number, login: string): Promise<{ status: number; location: string }> {
    mock.setGitHubUser({ id: ghId, login, name: `GH ${login}`, avatar_url: 'x' });
    mock.setGitHubEmails([{ email: `${login}@mail.example`, primary: true, verified: true, visibility: 'public' }]);
    const ip = nextIp();
    const start = await env.app.inject({ method: 'GET', url: '/api/auth/github/start', remoteAddress: ip });
    const state = new URL(String(start.headers['location'])).searchParams.get('state')!;
    const cookies = ([] as string[]).concat(start.headers['set-cookie'] as string[]);
    const value = (name: string) => cookies.find((c) => c.startsWith(`${name}=`))!.split(';')[0]!.slice(name.length + 1);
    const res = await env.app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
      remoteAddress: ip,
      cookies: { cfp_oauth_state: value('cfp_oauth_state'), cfp_oauth_session: value('cfp_oauth_session') },
    });
    return { status: res.statusCode, location: String(res.headers['location']) };
  }

  describe('the GitHub callback', () => {
    it('refuses a blocked GitHub id with signup_blocked, writing nothing', async () => {
      const before = await head();
      const res = await githubCallback(GH.blocked, 'promo-shop');
      expect(res).toEqual({ status: 302, location: '/login?error=signup_blocked' });
      expect(await head()).toBe(before);
      expect(env.app.inMemoryState.personIdBySlug.has('promo-shop')).toBe(false);
    });

    it('never blocks a live person holding the id (a member staff restored)', async () => {
      const res = await githubCallback(GH.restored, 'restored');
      expect(res.status).toBe(302);
      expect(res.location).toBe('/');
    });

    it('link-GitHub refuses a blocked id with github_blocked', async () => {
      const { access } = await issueSession(fid(LINKER), 'user', JWT_KEY, { loginMethod: 'legacy_password' });
      mock.setGitHubUser({ id: GH.blocked, login: 'promo-shop', name: 'x', avatar_url: 'x' });
      mock.setGitHubEmails([{ email: 'promo@mail.example', primary: true, verified: true, visibility: 'public' }]);
      const ip = nextIp();
      const start = await env.app.inject({ method: 'POST', url: '/api/auth/link-github', remoteAddress: ip, cookies: { cfp_session: access } });
      expect(start.statusCode).toBe(302);
      const state = new URL(String(start.headers['location'])).searchParams.get('state')!;
      const cookies = ([] as string[]).concat(start.headers['set-cookie'] as string[]);
      const value = (name: string) => cookies.find((c) => c.startsWith(`${name}=`))!.split(';')[0]!.slice(name.length + 1);
      const res = await env.app.inject({
        method: 'GET',
        url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
        remoteAddress: ip,
        cookies: { cfp_oauth_state: value('cfp_oauth_state'), cfp_oauth_session: value('cfp_oauth_session') },
      });
      expect(String(res.headers['location'])).toBe('/account?error=github_blocked');
      expect(env.app.inMemoryState.people.get(fid(LINKER))?.githubUserId).toBeUndefined();
    });
  });

  describe('the purge log', () => {
    it('lists records newest first with byRef, evidence urls and commitUrl (staff and reading agents)', async () => {
      const res = await env.app.inject({ method: 'GET', url: '/api/admin/spam-purges', cookies: { cfp_session: staff } });
      expect(res.statusCode).toBe(200);
      const items = res.json<{ data: Array<Rec & { byRef: Rec; commitUrl: string; blocking: boolean }> }>().data;
      const first = items.find((i) => i['id'] === OLD_PURGE_ID)!;
      expect(first.byRef).toEqual({ kind: 'human', slug: 'staffer', fullName: 'Test staffer' });
      expect(first.blocking).toBe(true);
      expect(first.commitUrl).toBe(
        `https://github.com/CodeForPhilly/codeforphilly-data/commits/published/spam-purges/promo-shop/${OLD_PURGE_ID}.toml`,
      );

      const agent = await createAgent(env, admin, { slug: 'log-reader', scopes: ['moderation:read'] });
      const asAgent = await env.app.inject({ method: 'GET', url: '/api/admin/spam-purges?by=human&blocking=true', ...bearer(agent.token) });
      expect(asAgent.statusCode).toBe(200);
      expect(asAgent.json<{ data: Rec[] }>().data.map((r) => r['id']).sort()).toEqual([OLD_PURGE_ID, RESTORED_PURGE_ID].sort());
      expect((await env.app.inject({ method: 'GET', url: '/api/admin/spam-purges?by=agent', ...bearer(agent.token) })).json<{ data: Rec[] }>().data).toEqual([]);
      expect((await env.app.inject({ method: 'GET', url: '/api/admin/spam-purges', cookies: { cfp_session: user } })).statusCode).toBe(404);
      const unblockAsAgent = await env.app.inject({ method: 'POST', url: `/api/admin/spam-purges/${OLD_PURGE_ID}/unblock`, ...bearer(agent.token) });
      expect(unblockAsAgent.statusCode).toBe(404);
    });
  });

  describe('unblocking', () => {
    it('lifts the block, keeps the record, and the same GitHub account can sign up again', async () => {
      const res = await env.app.inject({
        method: 'POST',
        url: `/api/admin/spam-purges/${OLD_PURGE_ID}/unblock`,
        cookies: { cfp_session: staff },
        payload: { reason: 'Person wrote in; a mistake.' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ data: { purge: Rec } }>().data.purge).toMatchObject({
        unblockedBySlug: 'staffer',
        unblockReason: 'Person wrote in; a mistake.',
        blocking: false,
        unblockedBy: { slug: 'staffer', fullName: 'Test staffer' },
      });
      const msg = await env.git('log', '-1', '--format=%B');
      expect(msg).toContain('Action: spam-purge.unblock');

      const before = await head();
      const again = await env.app.inject({ method: 'POST', url: `/api/admin/spam-purges/${OLD_PURGE_ID}/unblock`, cookies: { cfp_session: staff } });
      expect(again.statusCode).toBe(200);
      expect(await head()).toBe(before);

      const signup = await githubCallback(GH.blocked, 'promo-shop');
      expect(signup).toEqual({ status: 302, location: '/' });
      expect(env.app.inMemoryState.personIdBySlug.has('promo-shop')).toBe(true);
    });

    it('the new account shows slug-purged-before, no latest vote, and the old vote as an earlier one', async () => {
      const list = await env.app.inject({ method: 'GET', url: '/api/admin/members?q=promo-shop', cookies: { cfp_session: staff } });
      const row = list.json<{ data: Array<{ slug: string; signals: string[]; latestVote: unknown; purgeAfter: unknown }> }>().data[0]!;
      expect(row.slug).toBe('promo-shop');
      expect(row.signals).toContain('slug-purged-before');
      expect(row.latestVote).toBeNull();
      const detail = await env.app.inject({ method: 'GET', url: '/api/admin/members/promo-shop', cookies: { cfp_session: staff } });
      const d = detail.json<{ data: { votes: unknown[]; earlierVotes: Array<{ kind: string; verdict: string }>; earlierPurges: Array<{ id: string }> } }>().data;
      expect(d.votes).toEqual([]);
      expect(d.earlierVotes).toMatchObject([{ kind: 'human', verdict: 'spam' }]);
      expect(d.earlierPurges.map((p) => p.id)).toEqual([OLD_PURGE_ID]);
    });

    it('is staff only', async () => {
      const res = await env.app.inject({ method: 'POST', url: `/api/admin/spam-purges/${RESTORED_PURGE_ID}/unblock`, cookies: { cfp_session: user } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("an administrator's purge", () => {
    it('marked "This was spam" writes a blocking record in the same commit', async () => {
      const before = await head();
      const res = await env.app.inject({
        method: 'POST',
        url: '/api/people/staff-target/purge',
        cookies: { cfp_session: admin },
        payload: { spam: true, reason: 'Deals bio, no civic interest.' },
      });
      expect(res.statusCode, res.body).toBe(204);
      expect(Number((await env.git('rev-list', '--count', `${before}..HEAD`)).trim())).toBe(1);
      const files = await env.git('show', '--name-status', '--format=', 'HEAD');
      expect(files).toMatch(/^A\tspam-purges\/staff-target\/.+\.toml$/m);
      expect(files).toMatch(/^D\tpeople\/staff-target\.toml$/m);
      const [id] = [...(env.app.inMemoryState.spamPurgesByGithubUserId.get(GH.purgedByStaff) ?? [])];
      expect(env.app.inMemoryState.spamPurges.get(id!)).toMatchObject({
        by: 'human-boss',
        reason: 'Deals bio, no civic interest.',
        blocksSignIn: true,
        beforeCommit: before,
      });
      expect(await githubCallback(GH.purgedByStaff, 'staff-target')).toEqual({ status: 302, location: '/login?error=signup_blocked' });
    });

    it('not marked as spam writes no record and blocks nothing', async () => {
      const res = await env.app.inject({ method: 'POST', url: '/api/people/erase-me/purge', cookies: { cfp_session: admin } });
      expect(res.statusCode).toBe(204);
      expect(env.app.inMemoryState.spamPurgesByGithubUserId.has(GH.erased)).toBe(false);
      expect((await githubCallback(GH.erased, 'erase-me')).location).toBe('/');
    });

    it('refuses a reason with a URL', async () => {
      const res = await env.app.inject({
        method: 'POST',
        url: '/api/people/regular/purge',
        cookies: { cfp_session: admin },
        payload: { spam: true, reason: 'see https://spam.example/x' },
      });
      expect(res.statusCode).toBe(422);
      expect(env.app.inMemoryState.personIdBySlug.has('regular')).toBe(true);
    });
  });

  describe('the scheduled sweep', () => {
    it('writes a scheduled record naming the deciding voters, blocking the GitHub account', async () => {
      const now = new Date(Date.now() + 60_000);
      expect(await env.app.spamPurge.sweep(now)).toEqual(['swept']);
      const [id] = [...(env.app.inMemoryState.spamPurgesByGithubUserId.get(GH.swept) ?? [])];
      const record = env.app.inMemoryState.spamPurges.get(id!)!;
      expect(record).toMatchObject({ by: 'scheduled', personSlug: 'swept', blocksSignIn: true, evidence: [] });
      expect(record.reason).toContain('human-boss');
      const files = await env.git('show', '--name-status', '--format=', 'HEAD');
      expect(files).toMatch(/^A\tspam-purges\/swept\/.+\.toml$/m);
      const log = await env.app.inject({ method: 'GET', url: '/api/admin/spam-purges?by=scheduled', cookies: { cfp_session: staff } });
      expect(log.json<{ data: Array<{ byRef: Rec }> }>().data[0]!.byRef).toEqual({ kind: 'scheduled', slug: null, fullName: 'Daily sweep' });
    });
  });
});
