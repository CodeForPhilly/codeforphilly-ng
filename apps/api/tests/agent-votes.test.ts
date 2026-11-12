/**
 * Agent reads and staged votes — specs/api/moderation.md → Agent callers,
 * Agent votes, DELETE …/vote; specs/api/agents.md → withdraw-votes;
 * specs/behaviors/person-lifecycle.md → Deciding votes, Scheduled spam purge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { queuedForSpamPurge, spamPurgeDueAt } from '../src/services/spam-purge.js';
import {
  bearer,
  createAgent,
  daysAgo,
  fid,
  mintGrant,
  minutesAgo,
  personRecord,
  privateProfile,
  startAgentTestEnv,
  type AgentTestEnv,
  type Rec,
} from './helpers/agent-fixtures.js';

const ADMIN = 1;
const STAFF = 2;
const N = {
  fresh: 10,
  freshTwo: 11,
  old: 12,
  staffVoted: 13,
  selfOff: 14,
  confirm: 15,
  overrule: 16,
  revoked: 17,
  withdrawA: 18,
  withdrawB: 19,
  sweep: 20,
  late: 21,
};
const RATE_BASE = 100;
const DAY = 86_400_000;

interface Row {
  slug: string;
  email: string | null;
  emailDomain: string | null;
  deletedAt: string | null;
  latestVote: { verdict: string } | null;
  stagedVote: { verdict: string; agent: { slug: string }; reasoning: string; flags: string[]; counts: boolean } | null;
  purgeAfter: string | null;
  signals: string[];
}

describe('agent votes', () => {
  let env: AgentTestEnv;
  let admin: string;
  let staff: string;
  let bot: { token: string; grantId: string };
  let reader: { token: string; grantId: string };

  const people: Rec[] = [
    personRecord(ADMIN, 'boss', { accountLevel: 'administrator' }),
    personRecord(STAFF, 'staffer', { accountLevel: 'staff' }),
    personRecord(N.fresh, 'fresh-shop', { createdAt: minutesAgo(2) }),
    personRecord(N.freshTwo, 'fresh-two', { createdAt: daysAgo(1) }),
    personRecord(N.old, 'old-member', { createdAt: daysAgo(60) }),
    personRecord(N.staffVoted, 'staff-voted', { createdAt: daysAgo(1) }),
    personRecord(N.selfOff, 'self-off', { createdAt: daysAgo(2), deletedAt: daysAgo(1) }),
    personRecord(N.confirm, 'to-confirm', { createdAt: daysAgo(1) }),
    personRecord(N.overrule, 'to-overrule', { createdAt: daysAgo(1) }),
    personRecord(N.revoked, 'staged-revoked', { createdAt: daysAgo(1) }),
    personRecord(N.withdrawA, 'withdraw-a', { createdAt: daysAgo(1) }),
    personRecord(N.withdrawB, 'withdraw-b', { createdAt: daysAgo(1) }),
    personRecord(N.sweep, 'sweep-me', { createdAt: daysAgo(1) }),
    personRecord(N.late, 'late-target', { createdAt: daysAgo(1) }),
    ...Array.from({ length: 21 }, (_, i) => personRecord(RATE_BASE + i, `rate-${i}`, { createdAt: daysAgo(1) })),
  ];

  beforeAll(async () => {
    env = await startAgentTestEnv({
      records: {
        people,
        'person-evaluations': [
          { personSlug: 'staff-voted', evaluator: 'human-staffer', verdict: 'legit', confidence: 1, flags: ['manual-override'], evaluatedAt: minutesAgo(30) },
        ],
      },
      profiles: [
        privateProfile(fid(N.fresh), 'promo.desk@throwaway.example'),
        privateProfile(fid(N.old), 'old.member@example.org'),
      ],
    });
    admin = await env.cookie(ADMIN, 'administrator');
    staff = await env.cookie(STAFF, 'staff');
    bot = await createAgent(env, admin, { slug: 'example-bot', scopes: ['moderation:read', 'moderation:vote'] });
    reader = await createAgent(env, admin, { slug: 'reader-bot', scopes: ['moderation:read'] });
  }, 90_000);

  afterAll(async () => {
    await env.close();
  });

  const roster = async (query: string, auth: Record<string, unknown>): Promise<Row[]> => {
    const res = await env.app.inject({ method: 'GET', url: `/api/admin/members?perPage=200${query}`, ...auth });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ data: Row[] }>().data;
  };
  const row = async (slug: string): Promise<Row> =>
    (await roster('', { cookies: { cfp_session: staff } })).find((r) => r.slug === slug)!;
  const vote = (slug: string, payload: Rec, auth: Record<string, unknown> = bearer(bot.token)) =>
    env.app.inject({ method: 'POST', url: `/api/admin/members/${slug}/vote`, payload, ...auth });
  const unvote = (slug: string, auth: Record<string, unknown> = bearer(bot.token)) =>
    env.app.inject({ method: 'DELETE', url: `/api/admin/members/${slug}/vote`, ...auth });
  const spam = { verdict: 'spam', reasoning: 'Business name; GitHub account 3h old.', flags: ['business-name', 'github-new-account'] };
  const code = (res: { json: <T>() => T }) => res.json<{ error: { code: string } }>().error.code;

  describe('reading the roster', () => {
    it('an agent sees the email domain, never the address, and searches the domain only', async () => {
      const rows = await roster('', bearer(reader.token));
      const fresh = rows.find((r) => r.slug === 'fresh-shop')!;
      expect(fresh.email).toBeNull();
      expect(fresh.emailDomain).toBe('throwaway.example');
      expect(rows.every((r) => r.email === null)).toBe(true);

      expect((await roster('&q=throwaway.example', bearer(reader.token))).map((r) => r.slug)).toEqual(['fresh-shop']);
      expect(await roster('&q=promo.desk', bearer(reader.token))).toEqual([]);
      // Staff still search the whole address.
      expect((await roster('&q=promo.desk', { cookies: { cfp_session: staff } })).map((r) => r.slug)).toEqual(['fresh-shop']);
      expect((await row('fresh-shop')).email).toBe('promo.desk@throwaway.example');
    });

    it("an agent's detail omits the email but shows a deactivated member", async () => {
      const res = await env.app.inject({ method: 'GET', url: '/api/admin/members/self-off', ...bearer(reader.token) });
      expect(res.statusCode).toBe(200);
      const d = res.json<{ data: { person: { email: unknown; deletedAt: string | null }; email: unknown; votes: unknown[] } }>().data;
      expect(d.person.email ?? null).toBeNull();
      expect(d.email).toBeNull();
      expect(d.person.deletedAt).not.toBeNull();
      const fresh = await env.app.inject({ method: 'GET', url: '/api/admin/members/fresh-shop', ...bearer(reader.token) });
      expect(fresh.body).not.toContain('promo.desk');
    });

    it('a grant without moderation:vote gets 404 on vote and DELETE; staff cannot DELETE', async () => {
      expect((await vote('fresh-two', spam, bearer(reader.token))).statusCode).toBe(404);
      expect((await unvote('fresh-two', bearer(reader.token))).statusCode).toBe(404);
      expect((await unvote('fresh-two', { cookies: { cfp_session: staff } })).statusCode).toBe(404);
    });
  });

  describe('casting', () => {
    it('a spam vote hides the member, is labeled as the agent, and stages a purge in three days', async () => {
      const res = await vote('fresh-shop', spam);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ data: { person: { deletedAt: string | null }; vote: Rec; purgeAfter: string | null } }>().data;
      expect(body.person.deletedAt).not.toBeNull();
      expect(body.vote).toMatchObject({
        evaluator: 'agent-example-bot',
        verdict: 'spam',
        flags: ['agent', 'business-name', 'github-new-account'],
        reasoning: spam.reasoning,
      });
      expect(body.vote['confidence']).toBeUndefined();
      expect(Date.parse(body.purgeAfter!) - Date.parse(body.vote['evaluatedAt'] as string)).toBe(3 * DAY);

      const r = await row('fresh-shop');
      expect(r.latestVote).toBeNull();
      expect(r.stagedVote).toMatchObject({ verdict: 'spam', agent: { slug: 'example-bot' }, flags: ['business-name', 'github-new-account'], counts: true });
      expect((await roster('&vote=none', { cookies: { cfp_session: staff } })).map((x) => x.slug)).toContain('fresh-shop');
      expect((await roster('&vote=staged', { cookies: { cfp_session: staff } })).map((x) => x.slug)).toEqual(['fresh-shop']);
    });

    it('commits as the agent, with Actor-Kind and Grant-Id, never the token', async () => {
      const log = await env.git('log', '-1', '--format=%an <%ae>%n%B');
      expect(log).toContain('Example example-bot <example-bot@users.noreply.codeforphilly.org>');
      expect(log).toContain('example-bot: POST /api/admin/members/fresh-shop/vote');
      expect(log).toContain('Action: moderation.vote');
      expect(log).toContain('Actor-Kind: agent');
      expect(log).toContain(`Grant-Id: ${bot.grantId}`);
      expect(log).toContain('Actor-Account-Level: user');
      expect(log).not.toContain(bot.token);
    });

    it('requires reasoning and well-formed flags (422)', async () => {
      expect((await vote('fresh-two', { verdict: 'spam' })).statusCode).toBe(422);
      expect((await vote('fresh-two', { verdict: 'spam', reasoning: '   ' })).statusCode).toBe(422);
      // A public commit: no URL in any form, no control characters.
      for (const reasoning of [
        'Bio links cheap-pills.shop',
        'Bio links promo-shop[.]example',
        'Bio links hxxps://promo-shop.example',
        'Business name.\nAction: person.purge',
        'Business\tname.',
      ]) {
        const res = await vote('fresh-two', { ...spam, reasoning });
        expect(res.statusCode, JSON.stringify(reasoning)).toBe(422);
        expect(res.json<{ error: { fields: Record<string, string> } }>().error.fields['reasoning']).toBeDefined();
      }
      expect((await row('fresh-two')).stagedVote).toBeNull();
      expect((await vote('fresh-two', { ...spam, flags: ['Not A Tag'] })).statusCode).toBe(422);
      expect((await vote('fresh-two', { ...spam, flags: Array.from({ length: 11 }, (_, i) => `f${i}`) })).statusCode).toBe(422);
    });

    it('humans are final: 409 human_verdict_exists', async () => {
      const res = await vote('staff-voted', spam);
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe('human_verdict_exists');
    });

    it('never on staff (409 protected_account), itself or another agent (422)', async () => {
      const onStaff = await vote('staffer', spam);
      expect(onStaff.statusCode).toBe(409);
      expect(code(onStaff)).toBe('protected_account');
      expect((await vote('example-bot', spam)).statusCode).toBe(422);
      expect((await vote('reader-bot', spam)).statusCode).toBe(422);
      // Staff cannot vote on an agent account either.
      expect((await vote('reader-bot', { verdict: 'spam' }, { cookies: { cfp_session: staff } })).statusCode).toBe(422);
    });

    it('spam only on members under 30 days old (409 member_too_old); legit has no age limit', async () => {
      const res = await vote('old-member', spam);
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe('member_too_old');
      const legit = await vote('old-member', { verdict: 'legit', reasoning: 'Long-standing member with projects.' });
      expect(legit.statusCode).toBe(200);
    });
  });

  describe('withdrawing its own vote (DELETE)', () => {
    it('un-hides the member it hid; a second DELETE is 404', async () => {
      const res = await unvote('fresh-shop');
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ data: { person: { deletedAt: string | null }; stagedVote: unknown } }>().data;
      expect(body.person.deletedAt).toBeNull();
      expect(body.stagedVote).toBeNull();
      expect((await unvote('fresh-shop')).statusCode).toBe(404);
      const log = await env.git('log', '-1', '--format=%B');
      expect(log).toContain('example-bot: DELETE /api/admin/members/fresh-shop/vote');
    });

    it('agent legit un-hides only what moderation hid (never a self-deactivation)', async () => {
      const res = await vote('self-off', { verdict: 'legit', reasoning: 'Real bio, joined a project.' });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: { person: { deletedAt: string | null } } }>().data.person.deletedAt).not.toBeNull();
    });
  });

  describe('staff on a staged row', () => {
    it('Not spam overrules: un-hides, stops the purge, and the agent may not re-vote or withdraw', async () => {
      expect((await vote('to-overrule', spam)).statusCode).toBe(200);
      const res = await vote('to-overrule', { verdict: 'legit' }, { cookies: { cfp_session: staff } });
      expect(res.statusCode).toBe(200);
      const r = await row('to-overrule');
      expect(r.deletedAt).toBeNull();
      expect(r.purgeAfter).toBeNull();
      expect(r.stagedVote).toBeNull();
      expect(r.latestVote?.verdict).toBe('legit');

      const again = await vote('to-overrule', spam);
      expect(code(again)).toBe('human_verdict_exists');
      const withdraw = await unvote('to-overrule');
      expect(withdraw.statusCode).toBe(409);
      expect(code(withdraw)).toBe('human_verdict_exists');

      const detail = await env.app.inject({ method: 'GET', url: '/api/admin/members/to-overrule', cookies: { cfp_session: staff } });
      const votes = detail.json<{ data: { votes: Array<{ kind: string; verdict: string }> } }>().data.votes;
      expect(votes.map((v) => `${v.kind}:${v.verdict}`).sort()).toEqual(['agent:spam', 'human:legit']);
    });

    it('Spam confirms and restarts the three days from the staff vote', async () => {
      const agentVote = await vote('to-confirm', spam);
      const agentAt = Date.parse(agentVote.json<{ data: { vote: { evaluatedAt: string } } }>().data.vote.evaluatedAt);
      await new Promise((r) => setTimeout(r, 20));
      const res = await vote('to-confirm', { verdict: 'spam' }, { cookies: { cfp_session: staff } });
      const staffAt = Date.parse(res.json<{ data: { vote: { evaluatedAt: string } } }>().data.vote.evaluatedAt);
      expect(staffAt).toBeGreaterThan(agentAt);
      const r = await row('to-confirm');
      expect(Date.parse(r.purgeAfter!)).toBe(staffAt + 3 * DAY);
      expect(r.stagedVote).toBeNull();
      expect(r.latestVote?.verdict).toBe('spam');
    });
  });

  describe('volume', () => {
    it('20 spam votes in 24 hours; the 21st is 429 with Retry-After', async () => {
      const rate = await createAgent(env, admin, { slug: 'busy-bot', scopes: ['moderation:read', 'moderation:vote'] });
      for (let i = 0; i < 20; i++) {
        const res = await vote(`rate-${i}`, spam, bearer(rate.token));
        expect(res.statusCode, `vote ${i}: ${res.body}`).toBe(200);
      }
      const res = await vote('rate-20', spam, bearer(rate.token));
      expect(res.statusCode).toBe(429);
      const retry = Number(res.headers['retry-after']);
      expect(retry).toBeGreaterThan(23 * 3600);
      expect(retry).toBeLessThanOrEqual(24 * 3600);
      // A legit vote is not counted.
      expect((await vote('rate-20', { verdict: 'legit', reasoning: 'Looks real.' }, bearer(rate.token))).statusCode).toBe(200);
    }, 120_000);
  });

  describe('revoking the grant', () => {
    it("stops the agent's staged votes from counting toward a purge", async () => {
      const temp = await createAgent(env, admin, { slug: 'temp-bot', scopes: ['moderation:read', 'moderation:vote'] });
      expect((await vote('staged-revoked', spam, bearer(temp.token))).statusCode).toBe(200);
      expect((await row('staged-revoked')).purgeAfter).not.toBeNull();

      const revoke = await env.app.inject({
        method: 'POST',
        url: `/api/admin/agents/temp-bot/grants/${temp.grantId}/revoke`,
        cookies: { cfp_session: admin },
      });
      expect(revoke.statusCode).toBe(200);
      const r = await row('staged-revoked');
      expect(r.purgeAfter).toBeNull();
      expect(r.stagedVote?.counts).toBe(false);
      expect(r.deletedAt).not.toBeNull();
      const state = env.app.inMemoryState;
      const later = new Date(Date.now() + 4 * DAY);
      expect(queuedForSpamPurge(state, later).map((p) => p.slug)).not.toContain('staged-revoked');
      // And the token is dead at once.
      expect((await vote('fresh-two', spam, bearer(temp.token))).statusCode).toBe(401);
    });

    it('a new grant makes them count again (the rotation case)', async () => {
      await mintGrant(env, admin, 'temp-bot', ['moderation:read', 'moderation:vote']);
      const r = await row('staged-revoked');
      expect(r.stagedVote?.counts).toBe(true);
      expect(r.purgeAfter).not.toBeNull();
    });

    it('revoke with withdrawVotes also withdraws them, in the same commit (the compromise case)', async () => {
      const grant = env.app.services.agents.list().find((a) => a.person.slug === 'temp-bot')!.grants.find((g) => g.active)!;
      const before = Number((await env.git('rev-list', '--count', 'HEAD')).trim());
      const res = await env.app.inject({
        method: 'POST',
        url: `/api/admin/agents/temp-bot/grants/${grant.id}/revoke`,
        cookies: { cfp_session: admin },
        payload: { withdrawVotes: true },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ data: { grant: { active: boolean }; withdrawn: number; reactivated: number } }>().data).toMatchObject({
        grant: { active: false },
        withdrawn: 1,
        reactivated: 1,
      });
      expect(Number((await env.git('rev-list', '--count', 'HEAD')).trim())).toBe(before + 1);
      const msg = await env.git('log', '-1', '--format=%B');
      expect(msg).toContain('Action: agent.revoke');
      expect(msg).toContain(`Grant-Id: ${grant.id}`);
      expect(msg).toContain('Withdraw-Votes: true');
      const r = await row('staged-revoked');
      expect(r.stagedVote).toBeNull();
      expect(r.deletedAt).toBeNull();

      // A later grant has nothing to revive.
      await mintGrant(env, admin, 'temp-bot', ['moderation:read', 'moderation:vote']);
      expect((await row('staged-revoked')).purgeAfter).toBeNull();
    });

    it('withdrawVotes on a grant already revoked still withdraws', async () => {
      const late = await createAgent(env, admin, { slug: 'late-bot', scopes: ['moderation:read', 'moderation:vote'] });
      expect((await vote('late-target', spam, bearer(late.token))).statusCode).toBe(200);
      const url = `/api/admin/agents/late-bot/grants/${late.grantId}/revoke`;
      expect((await env.app.inject({ method: 'POST', url, cookies: { cfp_session: admin } })).statusCode).toBe(200);
      const res = await env.app.inject({ method: 'POST', url, cookies: { cfp_session: admin }, payload: { withdrawVotes: true } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ data: { withdrawn: number } }>().data.withdrawn).toBe(1);
      expect((await row('late-target')).stagedVote).toBeNull();
    });
  });

  describe('withdraw-votes (staff)', () => {
    it('deletes the staged votes in one commit, un-hides, and leaves votes a human followed', async () => {
      const w = await createAgent(env, admin, { slug: 'wrong-bot', scopes: ['moderation:read', 'moderation:vote'] });
      expect((await vote('withdraw-a', spam, bearer(w.token))).statusCode).toBe(200);
      expect((await vote('withdraw-b', spam, bearer(w.token))).statusCode).toBe(200);
      expect((await vote('withdraw-b', { verdict: 'spam' }, { cookies: { cfp_session: staff } })).statusCode).toBe(200);

      const before = Number((await env.git('rev-list', '--count', 'HEAD')).trim());
      const url = '/api/admin/agents/wrong-bot/withdraw-votes';
      expect((await env.app.inject({ method: 'POST', url, ...bearer(w.token) })).statusCode).toBe(404);
      const res = await env.app.inject({ method: 'POST', url, cookies: { cfp_session: staff }, payload: {} });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ data: { withdrawn: number; reactivated: number } }>().data).toEqual({ withdrawn: 1, reactivated: 1 });
      expect(Number((await env.git('rev-list', '--count', 'HEAD')).trim())).toBe(before + 1);
      expect(await env.git('log', '-1', '--format=%B')).toContain('Action: agent.withdraw-votes');

      expect((await row('withdraw-a')).deletedAt).toBeNull();
      const b = await env.app.inject({ method: 'GET', url: '/api/admin/members/withdraw-b', cookies: { cfp_session: staff } });
      const votes = b.json<{ data: { votes: Array<{ kind: string }> } }>().data.votes;
      expect(votes.map((v) => v.kind).sort()).toEqual(['agent', 'human']);
    });
  });

  describe('the agents list', () => {
    it('counts staged votes on people no human has voted on', async () => {
      const res = await env.app.inject({ method: 'GET', url: '/api/admin/agents', cookies: { cfp_session: staff } });
      const busy = res.json<{ data: Array<{ person: { slug: string }; stagedVotes: { spam: number; legit: number } }> }>().data.find(
        (a) => a.person.slug === 'busy-bot',
      )!;
      expect(busy.stagedVotes).toEqual({ spam: 20, legit: 1 });
    });
  });

  describe('the scheduled sweep', () => {
    it('purges an agent-only spam member after three days, listed as staged, with Agent-Staged', async () => {
      expect((await vote('sweep-me', spam)).statusCode).toBe(200);
      const later = new Date(Date.now() + 3 * DAY + 60_000);
      const queued = queuedForSpamPurge(env.app.inMemoryState, later).map((p) => p.slug);
      expect(queued).toContain('sweep-me');
      expect(queued).not.toContain('staged-revoked');

      const purged = await env.app.spamPurge.sweep(later);
      expect(purged).toContain('sweep-me');
      const msg = await env.git('log', '-1', '--format=%B');
      expect(msg).toContain('sweep-me (staged by agent-example-bot)');
      // to-confirm was decided by staff: listed plainly.
      expect(msg).toMatch(/^to-confirm$/m);
      // sweep-me plus busy-bot's twenty: queued on agent votes alone.
      expect(msg).toMatch(/^Agent-Staged: 21$/m);
    });

    it('never queues an agent account', async () => {
      const state = env.app.inMemoryState;
      const agent = state.people.get(state.personIdBySlug.get('reader-bot')!)!;
      const hidden = { ...agent, deletedAt: daysAgo(10) };
      state.personEvaluations.set('reader-bot/human-staffer', {
        personSlug: 'reader-bot', evaluator: 'human-staffer', verdict: 'spam', confidence: 1, flags: [], evaluatedAt: new Date().toISOString(),
      });
      state.evaluationsByPerson.set('reader-bot', new Set(['reader-bot/human-staffer']));
      try {
        expect(spamPurgeDueAt(state, hidden, new Date(Date.now() + 10 * DAY))).toBeNull();
      } finally {
        state.personEvaluations.delete('reader-bot/human-staffer');
        state.evaluationsByPerson.delete('reader-bot');
      }
    });
  });

});
