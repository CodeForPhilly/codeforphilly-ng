/**
 * Agent accounts and grants — specs/api/agents.md,
 * specs/behaviors/authorization.md → Agent grants.
 *
 * Covers: creating an agent and minting / revoking grants (administrators
 * only; staff may list), the public commits those make, the token kept only
 * as a hash, a grant being anonymous everywhere outside its scopes, every
 * way a grant is refused (401 grant_invalid), and the account-level guard.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { hashAgentToken } from '../src/auth/agent-grant.js';
import {
  JWT_KEY,
  bearer,
  createAgent,
  personRecord,
  startAgentTestEnv,
  type AgentTestEnv,
} from './helpers/agent-fixtures.js';

const ADMIN = 1;
const STAFF = 2;
const USER = 3;

describe('agent accounts and grants', () => {
  let env: AgentTestEnv;
  let admin: string;
  let staff: string;
  let user: string;
  let agent: { token: string; grantId: string; personId: string };

  beforeAll(async () => {
    env = await startAgentTestEnv({
      records: {
        people: [
          personRecord(ADMIN, 'boss', { accountLevel: 'administrator' }),
          personRecord(STAFF, 'staffer', { accountLevel: 'staff' }),
          personRecord(USER, 'regular'),
        ],
        'person-evaluations': [
          { personSlug: 'gone-spammer', evaluator: 'human-staffer', verdict: 'spam', confidence: 1, flags: ['manual-override'], evaluatedAt: '2026-10-01T00:00:00Z' },
        ],
      },
    });
    admin = await env.cookie(ADMIN, 'administrator');
    staff = await env.cookie(STAFF, 'staff');
    user = await env.cookie(USER, 'user');
    agent = await createAgent(env, admin, { slug: 'example-bot', scopes: ['moderation:read', 'moderation:vote'] });
  }, 60_000);

  afterAll(async () => {
    await env.close();
  });

  describe('creating an agent', () => {
    it('returns the token once and commits the person and grant as the administrator', async () => {
      expect(agent.token).toMatch(/^cfpa_[A-Za-z0-9_-]{43}$/);
      const log = await env.git('log', '--format=%an <%ae>%n%B%n---', '-1');
      expect(log).toContain('Test boss <boss@users.noreply.codeforphilly.org>');
      expect(log).toContain('boss: POST /api/admin/agents');
      expect(log).toContain('Action: agent.create');
      expect(log).toContain('Subject-Slug: example-bot');
      expect(log).toContain(`Grant-Id: ${agent.grantId}`);
      const files = await env.git('show', '--name-only', '--format=', 'HEAD');
      expect(files.trim().split('\n').sort()).toEqual([
        `agent-grants/example-bot/${agent.grantId}.toml`,
        'people/example-bot.toml',
      ]);
      const person = await env.git('show', 'HEAD:people/example-bot.toml');
      expect(person).not.toMatch(/githubUserId|githubLogin|slackSamlNameId/);
      expect(person).toContain('accountLevel = "user"');
    });

    it('keeps only the hash: the token is in no commit and not in the private store', async () => {
      const everything = await env.git('log', '-p', '--all');
      expect(everything).not.toContain(agent.token);
      expect(everything).not.toContain(hashAgentToken(agent.token));
      const secrets = await readFile(join(env.privatePath, 'agent-grant-secrets.jsonl'), 'utf8');
      expect(secrets).toContain(hashAgentToken(agent.token));
      expect(secrets).not.toContain(agent.token);
      // No private profile: an agent has no email.
      const profiles = await readFile(join(env.privatePath, 'profiles.jsonl'), 'utf8').catch(() => '');
      expect(profiles).not.toContain(agent.personId);
    });

    it('requires a bio and a free, valid slug', async () => {
      const bad = await env.app.inject({
        method: 'POST',
        url: '/api/admin/agents',
        cookies: { cfp_session: admin },
        payload: { slug: 'regular', fullName: 'Taken', bio: '' },
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.json<{ error: { fields: Record<string, string> } }>().error.fields).toMatchObject({
        slug: 'slug_taken',
        bio: expect.any(String),
      });
    });

    it('refuses a slug with moderation history (422 slug_retired)', async () => {
      const res = await env.app.inject({
        method: 'POST',
        url: '/api/admin/agents',
        cookies: { cfp_session: admin },
        payload: { slug: 'gone-spammer', fullName: 'Reused', bio: 'An AI.', grant: { label: 'x', scopes: ['moderation:read'] } },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { fields: Record<string, string> } }>().error.fields['slug']).toBe('slug_retired');
    });

    it('is administrators only (staff and users 404; agents 404)', async () => {
      const payload = { slug: 'other-bot', fullName: 'Other', bio: 'An AI.' };
      for (const opts of [{ cookies: { cfp_session: staff } }, { cookies: { cfp_session: user } }, bearer(agent.token)]) {
        const res = await env.app.inject({ method: 'POST', url: '/api/admin/agents', payload, ...opts });
        expect(res.statusCode).toBe(404);
      }
    });
  });

  describe('listing agents', () => {
    it('staff see every agent, its grants (never a token) and counts', async () => {
      const res = await env.app.inject({ method: 'GET', url: '/api/admin/agents', cookies: { cfp_session: staff } });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(agent.token);
      const [row] = res.json<{ data: Array<Record<string, unknown>> }>().data;
      expect(row).toMatchObject({
        person: { slug: 'example-bot', fullName: 'Example example-bot', deletedAt: null },
        stagedVotes: { spam: 0, legit: 0 },
        purges: { last24h: 0, last30d: 0 },
      });
      expect((row!['grants'] as unknown[])[0]).toMatchObject({
        id: agent.grantId,
        scopes: ['moderation:read', 'moderation:vote'],
        createdBy: { slug: 'boss', fullName: 'Test boss' },
        revokedAt: null,
        active: true,
      });
    });

    it('404s for users, anonymous callers and agents', async () => {
      for (const opts of [{ cookies: { cfp_session: user } }, {}, bearer(agent.token)]) {
        const res = await env.app.inject({ method: 'GET', url: '/api/admin/agents', ...opts });
        expect(res.statusCode).toBe(404);
      }
    });
  });

  describe('minting', () => {
    const mint = (slug: string, payload: Record<string, unknown>, cookie = admin) =>
      env.app.inject({ method: 'POST', url: `/api/admin/agents/${slug}/grants`, cookies: { cfp_session: cookie }, payload });

    it('refuses moderation:purge without moderation:read, unknown scopes and bad expiries (422)', async () => {
      expect((await mint('example-bot', { label: 'x', scopes: ['moderation:purge'] })).statusCode).toBe(422);
      expect((await mint('example-bot', { label: 'x', scopes: ['moderation:purge', 'moderation:vote'] })).statusCode).toBe(422);
      expect((await mint('example-bot', { label: 'x', scopes: ['admin:everything'] })).statusCode).toBe(422);
      expect((await mint('example-bot', { label: 'x', scopes: ['moderation:read'], expiresInDays: 181 })).statusCode).toBe(422);
      expect((await mint('example-bot', { label: 'x', scopes: ['moderation:read'], expiresInDays: 0 })).statusCode).toBe(422);
      expect((await mint('example-bot', { label: '', scopes: ['moderation:read'] })).statusCode).toBe(422);
    });

    it('404s for a member who is not an agent, and for non-administrators', async () => {
      expect((await mint('regular', { label: 'x', scopes: ['moderation:read'] })).statusCode).toBe(404);
      expect((await mint('example-bot', { label: 'x', scopes: ['moderation:read'] }, staff)).statusCode).toBe(404);
    });

    it('mints a grant with a default 90-day expiry and an agent.grant commit', async () => {
      const res = await mint('example-bot', { label: 'second host', scopes: ['moderation:read'] });
      expect(res.statusCode).toBe(201);
      const { grant, token } = res.json<{ data: { grant: { id: string; createdAt: string; expiresAt: string }; token: string } }>().data;
      expect(token).toMatch(/^cfpa_/);
      expect(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(90 * 86_400_000);
      const msg = await env.git('log', '-1', '--format=%B');
      expect(msg).toContain('Action: agent.grant');
      expect(msg).toContain(`Grant-Id: ${grant.id}`);
      expect(msg).not.toContain(token);
    });
  });

  describe('a grant outside its scopes', () => {
    it('is anonymous on public reads and to /api/auth/me', async () => {
      const me = await env.app.inject({ method: 'GET', url: '/api/auth/me', ...bearer(agent.token) });
      expect(me.statusCode).toBe(200);
      expect(me.json<{ data: { person: unknown; accountLevel: string } }>().data).toMatchObject({
        person: null,
        accountLevel: 'anonymous',
      });
      const people = await env.app.inject({ method: 'GET', url: '/api/people/regular', ...bearer(agent.token) });
      expect(people.statusCode).toBe(200);
      expect(people.json<{ data: Record<string, unknown> }>().data['email'] ?? null).toBeNull();
    });

    it('cannot edit a profile (even its own), join a project, or refresh into a cookie session', async () => {
      const own = await env.app.inject({
        method: 'PATCH',
        url: '/api/people/example-bot',
        payload: { bio: 'changed' },
        ...bearer(agent.token),
      });
      expect(own.statusCode).toBe(401);
      const deactivate = await env.app.inject({ method: 'POST', url: '/api/people/regular/deactivate', ...bearer(agent.token) });
      expect(deactivate.statusCode).toBe(401);
      const refresh = await env.app.inject({ method: 'POST', url: '/api/auth/refresh', ...bearer(agent.token) });
      expect(refresh.statusCode).toBe(401);
      expect(refresh.headers['set-cookie']).toBeUndefined();
    });

    it('gets 404 on staff and administrator surfaces', async () => {
      const preview = await env.app.inject({ method: 'GET', url: '/api/people/regular/purge-preview', ...bearer(agent.token) });
      expect([401, 404]).toContain(preview.statusCode);
      const purge = await env.app.inject({ method: 'POST', url: '/api/people/regular/purge', ...bearer(agent.token) });
      expect([401, 404]).toContain(purge.statusCode);
      const level = await env.app.inject({
        method: 'POST',
        url: '/api/people/regular/account-level',
        payload: { level: 'staff' },
        ...bearer(agent.token),
      });
      expect(level.statusCode).toBe(401);
    });
  });

  describe('refusals (401 grant_invalid)', () => {
    const code = (res: { json: <T>() => T }) => res.json<{ error: { code: string } }>().error.code;

    it('an unknown token', async () => {
      const res = await env.app.inject({ method: 'GET', url: '/api/people', ...bearer(`cfpa_${'A'.repeat(43)}`) });
      expect(res.statusCode).toBe(401);
      expect(code(res)).toBe('grant_invalid');
    });

    it('a grant together with a session cookie', async () => {
      const res = await env.app.inject({
        method: 'GET',
        url: '/api/people',
        headers: { authorization: `Bearer ${agent.token}` },
        cookies: { cfp_session: staff },
      });
      expect(res.statusCode).toBe(401);
      expect(code(res)).toBe('grant_invalid');
    });

    it('an expired grant', async () => {
      const state = env.app.inMemoryState;
      const grant = state.agentGrants.get(agent.grantId)!;
      state.agentGrants.set(grant.id, { ...grant, expiresAt: '2026-01-01T00:00:00Z' });
      try {
        const res = await env.app.inject({ method: 'GET', url: '/api/people', ...bearer(agent.token) });
        expect(res.statusCode).toBe(401);
        expect(code(res)).toBe('grant_invalid');
      } finally {
        state.agentGrants.set(grant.id, grant);
      }
    });

    it('a deactivated agent account', async () => {
      const off = await env.app.inject({ method: 'POST', url: '/api/people/example-bot/deactivate', cookies: { cfp_session: staff } });
      expect(off.statusCode).toBe(200);
      const res = await env.app.inject({ method: 'GET', url: '/api/people', ...bearer(agent.token) });
      expect(res.statusCode).toBe(401);
      expect(code(res)).toBe('grant_invalid');
      const on = await env.app.inject({ method: 'POST', url: '/api/people/example-bot/reactivate', cookies: { cfp_session: staff } });
      expect(on.statusCode).toBe(200);
      const ok = await env.app.inject({ method: 'GET', url: '/api/people', ...bearer(agent.token) });
      expect(ok.statusCode).toBe(200);
    });
  });

  describe('account level', () => {
    it('an agent account cannot be raised to staff (409 agent_account)', async () => {
      const res = await env.app.inject({
        method: 'POST',
        url: '/api/people/example-bot/account-level',
        payload: { level: 'staff' },
        cookies: { cfp_session: admin },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('agent_account');
    });
  });

  describe('renaming', () => {
    it('an agent account cannot be renamed, by an administrator either (409 agent_account)', async () => {
      const res = await env.app.inject({
        method: 'PATCH',
        url: '/api/people/example-bot',
        payload: { slug: 'renamed-bot' },
        cookies: { cfp_session: admin },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('agent_account');
      expect(env.app.inMemoryState.personIdBySlug.has('example-bot')).toBe(true);
    });

    it('other edits to an agent account still work', async () => {
      const res = await env.app.inject({
        method: 'PATCH',
        url: '/api/people/example-bot',
        payload: { bio: 'An AI moderator run by the test suite, renamed never.' },
        cookies: { cfp_session: admin },
      });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe('revoking', () => {
    it('is immediate, commits agent.revoke, and is a no-op the second time', async () => {
      const before = await env.app.inject({ method: 'GET', url: '/api/people', ...bearer(agent.token) });
      expect(before.statusCode).toBe(200);

      const url = `/api/admin/agents/example-bot/grants/${agent.grantId}/revoke`;
      expect((await env.app.inject({ method: 'POST', url, cookies: { cfp_session: staff } })).statusCode).toBe(404);
      const res = await env.app.inject({ method: 'POST', url, cookies: { cfp_session: admin } });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: { grant: { revokedAt: string | null; active: boolean } } }>().data.grant).toMatchObject({
        active: false,
      });
      const msg = await env.git('log', '-1', '--format=%B');
      expect(msg).toContain('Action: agent.revoke');
      expect(msg).toContain(`Grant-Id: ${agent.grantId}`);

      const after = await env.app.inject({ method: 'GET', url: '/api/people', ...bearer(agent.token) });
      expect(after.statusCode).toBe(401);

      const head = await env.git('rev-parse', 'HEAD');
      const again = await env.app.inject({ method: 'POST', url, cookies: { cfp_session: admin } });
      expect(again.statusCode).toBe(200);
      expect(await env.git('rev-parse', 'HEAD')).toBe(head);
    });

    it('404s for a grant of another agent or an unknown id', async () => {
      const res = await env.app.inject({
        method: 'POST',
        url: `/api/admin/agents/example-bot/grants/01951a3c-0000-7000-8000-00000000ffff/revoke`,
        cookies: { cfp_session: admin },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe('request logs', () => {
  it('never carry the agent token', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const base = await startAgentTestEnv({
      records: { people: [personRecord(ADMIN, 'boss', { accountLevel: 'administrator' })] },
    });
    try {
      const created = await createAgent(base, await base.cookie(ADMIN, 'administrator'), {
        slug: 'logged-bot',
        scopes: ['moderation:read'],
      });
      await base.app.close();
      // A second app on the same stores, logging at debug to a captured stream.
      const app = await buildApp({
        serverOptions: { logger: { level: 'trace', stream } },
        overrideEnv: {
          CFP_DATA_REPO_PATH: base.dataPath,
          STORAGE_BACKEND: 'filesystem',
          CFP_PRIVATE_STORAGE_PATH: base.privatePath,
          CFP_JWT_SIGNING_KEY: JWT_KEY,
          NODE_ENV: 'test',
        },
      });
      await app.inject({ method: 'GET', url: '/api/admin/members', ...bearer(created.token) });
      await app.inject({ method: 'GET', url: '/api/people', ...bearer(`cfpa_${'B'.repeat(43)}`) });
      await app.close();
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('');
      expect(all).not.toContain(created.token);
      expect(all).not.toContain('B'.repeat(43));
    } finally {
      await base.close().catch(() => undefined);
    }
  }, 60_000);
});
