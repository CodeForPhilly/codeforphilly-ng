/**
 * Agent purges and votes fired at once — specs/api/moderation.md → "Agent
 * purges" and "Agent votes": the check, the commit and the update of the
 * in-memory state happen under one lock, so a purge or vote queued behind
 * another is checked against its result.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bearer,
  createAgent,
  minutesAgo,
  personRecord,
  startAgentTestEnv,
  type AgentTestEnv,
} from './helpers/agent-fixtures.js';

const ADMIN = 1;
const STAFF = 2;
const BIO = { bio: 'Cheap streaming, all channels, no subscription. Ask me how.' };
const reason = 'Promotional bio.';
const evidence = [{ record: 'person', field: 'bio' }];

describe('agent purges and votes at once', () => {
  let env: AgentTestEnv;
  let admin: string;
  let staff: string;

  beforeAll(async () => {
    env = await startAgentTestEnv({
      records: {
        people: [
          personRecord(ADMIN, 'boss', { accountLevel: 'administrator' }),
          personRecord(STAFF, 'staffer', { accountLevel: 'staff' }),
          ...Array.from({ length: 8 }, (_, i) => personRecord(100 + i, `rush-${i}`, { createdAt: minutesAgo(5), ...BIO })),
          personRecord(200, 'twice', { createdAt: minutesAgo(5), ...BIO }),
          personRecord(201, 'contested', { createdAt: minutesAgo(5), ...BIO }),
          ...Array.from({ length: 22 }, (_, i) => personRecord(300 + i, `vote-rush-${i}`, { createdAt: minutesAgo(5), ...BIO })),
        ],
      },
    });
    admin = await env.cookie(ADMIN, 'administrator');
    staff = await env.cookie(STAFF, 'staff');
  }, 60_000);

  afterAll(async () => {
    await env.close();
  });

  const purge = (slug: string, token: string) =>
    env.app.inject({ method: 'POST', url: `/api/admin/members/${slug}/purge`, payload: { reason, evidence }, ...bearer(token) });
  const commitCount = async () => Number((await env.git('rev-list', '--count', 'HEAD')).trim());
  const purgesBy = (agentSlug: string) =>
    [...env.app.inMemoryState.spamPurges.values()].filter((p) => p.by === `agent-${agentSlug}`);

  it('eight purges at once never pass the five-a-day allowance', async () => {
    const bot = await createAgent(env, admin, { slug: 'rush-bot', scopes: ['moderation:read', 'moderation:purge'] });
    const before = await commitCount();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => purge(`rush-${i}`, bot.token)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
    expect(purgesBy('rush-bot')).toHaveLength(5);
    expect(await commitCount()).toBe(before + 5);
  }, 60_000);

  it('two purges of one member at once make one commit and one record', async () => {
    const one = await createAgent(env, admin, { slug: 'twin-bot', scopes: ['moderation:read', 'moderation:purge'] });
    const before = await commitCount();
    const results = await Promise.all([purge('twice', one.token), purge('twice', one.token)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    expect(await commitCount()).toBe(before + 1);
    expect([...env.app.inMemoryState.spamPurges.values()].filter((p) => p.personSlug === 'twice')).toHaveLength(1);
  }, 60_000);

  it('a staff Not spam vote and a purge at once: never both', async () => {
    const bot = await createAgent(env, admin, { slug: 'race-bot', scopes: ['moderation:read', 'moderation:purge'] });
    const [vote, purged] = await Promise.all([
      env.app.inject({
        method: 'POST',
        url: '/api/admin/members/contested/vote',
        payload: { verdict: 'legit' },
        cookies: { cfp_session: staff },
      }),
      purge('contested', bot.token),
    ]);
    const outcome = [vote.statusCode, purged.statusCode];
    // Vote first → the purge sees the human verdict (409); purge first → the
    // vote finds no member (404).
    expect([
      [200, 409],
      [404, 200],
    ]).toContainEqual(outcome);
  }, 60_000);

  it('22 spam votes at once never pass the twenty-a-day allowance', async () => {
    const bot = await createAgent(env, admin, { slug: 'vote-bot', scopes: ['moderation:read', 'moderation:vote'] });
    const results = await Promise.all(
      Array.from({ length: 22 }, (_, i) =>
        env.app.inject({
          method: 'POST',
          url: `/api/admin/members/vote-rush-${i}/vote`,
          payload: { verdict: 'spam', reasoning: 'Business name.' },
          ...bearer(bot.token),
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(20);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  }, 60_000);
});
