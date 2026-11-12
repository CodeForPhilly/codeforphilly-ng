/**
 * Agent purge — specs/api/moderation.md → POST /api/admin/members/:slug/purge
 * and "Agent purges" (rules 1–8, effects, the commit);
 * specs/behaviors/person-lifecycle.md → Agent purge.
 *
 * The two shapes the feature was designed against, described generically:
 *  - case 1: a business name and, within two minutes, a promotional bio with
 *    a link; the agent purges citing the bio;
 *  - case 2: a site name that self-joined someone else's project as a plain
 *    member and set a promotional bio; the purge takes their membership and
 *    leaves the project and everyone else's records alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { containsUrl } from '../src/services/agent-purge.js';
import {
  bearer,
  createAgent,
  daysAgo,
  fid,
  minutesAgo,
  personRecord,
  privateProfile,
  startAgentTestEnv,
  type AgentTestEnv,
  type Rec,
} from './helpers/agent-fixtures.js';

const ADMIN = 1;
const STAFF = 2;
const MAE = 3;
const HAL = 4;
const N = {
  promo: 10,
  site: 11,
  tooOld: 12,
  humanVoted: 13,
  agentLegit: 14,
  slacker: 15,
  sharedCreator: 16,
  coMaintainer: 17,
  emptyBio: 18,
  rolePoster: 19,
  imported: 20,
  ownProject: 21,
};
const BURST = 40;
const GH_ID = 987_654;
const PROMO_BIO = 'Promo Shop: the best deals in town. Order now at [our store](https://promo-shop.example/deals)!';
const NOW_ISO = new Date().toISOString();
const ROLE_ID = fid(700);
const AVATAR = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const membership = (n: number, projectSlug: string, personSlug: string, isMaintainer = false): Rec => ({
  id: fid(n),
  projectSlug,
  personSlug,
  role: isMaintainer ? 'Maintainer' : 'Member',
  isMaintainer,
  joinedAt: minutesAgo(1),
  createdAt: minutesAgo(1),
  updatedAt: minutesAgo(1),
});
const project = (n: number, slug: string, creator: number, over: Rec = {}): Rec => ({
  id: fid(n),
  slug,
  title: `Project ${slug}`,
  summary: `Summary of ${slug}`,
  stage: 'commenting',
  createdById: fid(creator),
  maintainerId: fid(creator),
  createdAt: daysAgo(30),
  updatedAt: daysAgo(30),
  ...over,
});

describe('agent purge', () => {
  let env: AgentTestEnv;
  let admin: string;
  let staff: string;
  let bot: { token: string; grantId: string };
  let voter: { token: string; grantId: string };

  beforeAll(async () => {
    const bio = { bio: 'Cheap streaming, all channels, no subscription. Ask me how.' };
    env = await startAgentTestEnv({
      records: {
        people: [
          personRecord(ADMIN, 'boss', { accountLevel: 'administrator' }),
          personRecord(STAFF, 'staffer', { accountLevel: 'staff' }),
          personRecord(MAE, 'maintainer-mae', { createdAt: daysAgo(300) }),
          personRecord(HAL, 'helper-hal', { createdAt: daysAgo(200) }),
          personRecord(N.promo, 'promo-shop', {
            fullName: 'Promo Shop LLC',
            createdAt: minutesAgo(2),
            githubUserId: GH_ID,
            githubLogin: 'promo-shop',
            bio: PROMO_BIO,
            avatarKey: 'people/promo-shop/avatar.jpg',
          }),
          personRecord(N.site, 'site-name', { fullName: 'Stream Site', createdAt: minutesAgo(1), githubUserId: GH_ID + 1, ...bio }),
          personRecord(N.tooOld, 'too-old', { createdAt: daysAgo(8), ...bio }),
          personRecord(N.humanVoted, 'human-voted', { createdAt: daysAgo(1), ...bio }),
          personRecord(N.agentLegit, 'agent-legit', { createdAt: daysAgo(1), ...bio }),
          personRecord(N.slacker, 'slacker', { createdAt: daysAgo(1), ...bio }),
          personRecord(N.sharedCreator, 'shared-creator', { createdAt: daysAgo(1), ...bio }),
          personRecord(N.coMaintainer, 'co-maintainer', { createdAt: daysAgo(1), ...bio }),
          personRecord(N.emptyBio, 'empty-bio', { createdAt: daysAgo(1) }),
          personRecord(N.rolePoster, 'role-poster', { createdAt: daysAgo(1), ...bio }),
          personRecord(N.imported, 'imported', { createdAt: daysAgo(1), legacyId: 1234, ...bio }),
          personRecord(N.ownProject, 'own-project', { createdAt: daysAgo(1) }),
          ...Array.from({ length: 6 }, (_, i) => personRecord(BURST + i, `burst-${i}`, { createdAt: minutesAgo(5), ...bio })),
        ],
        projects: [
          project(500, 'real-project', MAE),
          project(501, 'shared-proj', N.sharedCreator),
          project(502, 'spam-proj', N.ownProject, { summary: 'Buy followers cheap' }),
        ],
        'project-memberships': [
          membership(600, 'real-project', 'maintainer-mae', true),
          membership(601, 'real-project', 'helper-hal'),
          membership(602, 'real-project', 'site-name'),
          membership(603, 'shared-proj', 'shared-creator', true),
          membership(604, 'shared-proj', 'helper-hal'),
          membership(605, 'real-project', 'co-maintainer', true),
          membership(606, 'real-project', 'role-poster'),
          membership(607, 'spam-proj', 'own-project', true),
        ],
        'project-updates': [
          { id: fid(800), projectSlug: 'real-project', authorId: fid(HAL), body: 'Sprint notes', number: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO },
          { id: fid(801), projectSlug: 'real-project', authorId: fid(N.site), body: 'Watch every channel free!', number: 2, createdAt: NOW_ISO, updatedAt: NOW_ISO },
          { id: fid(802), projectSlug: 'spam-proj', authorId: fid(N.ownProject), body: 'Followers for sale', number: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO },
        ],
        'help-wanted-roles': [
          { id: ROLE_ID, projectSlug: 'real-project', postedById: fid(N.rolePoster), title: 'Paid promoter', description: 'Promote my shop', status: 'open', createdAt: NOW_ISO, updatedAt: NOW_ISO },
        ],
        'person-evaluations': [
          { personSlug: 'human-voted', evaluator: 'human-staffer', verdict: 'spam', confidence: 1, flags: ['manual-override'], evaluatedAt: NOW_ISO },
          { personSlug: 'agent-legit', evaluator: 'agent-example-bot', verdict: 'legit', flags: ['agent'], reasoning: 'Looked real.', evaluatedAt: NOW_ISO },
        ],
      },
      profiles: [privateProfile(fid(N.slacker), 'slacker@example.org', { lastSlackSsoAt: minutesAgo(10) })],
      extra: async (tx) => {
        const people = tx.sheet('people');
        const [promo] = (await people.queryAll()).filter((p) => (p as Rec)['slug'] === 'promo-shop');
        await people.setAttachment(promo!, 'avatar.jpg', AVATAR);
      },
    });
    admin = await env.cookie(ADMIN, 'administrator');
    staff = await env.cookie(STAFF, 'staff');
    bot = await createAgent(env, admin, {
      slug: 'example-bot',
      scopes: ['moderation:read', 'moderation:vote', 'moderation:purge'],
    });
    voter = await createAgent(env, admin, { slug: 'voter-bot', scopes: ['moderation:read', 'moderation:vote'] });
  }, 90_000);

  afterAll(async () => {
    await env.close();
  });

  const purge = (slug: string, payload: Rec, auth: Record<string, unknown> = bearer(bot.token)) =>
    env.app.inject({ method: 'POST', url: `/api/admin/members/${slug}/purge`, payload, ...auth });
  const bioEvidence = [{ record: 'person', field: 'bio' }];
  const reason = 'Signed up under a business name; 90 s later set a bio advertising that business, with a link.';
  const head = async () => (await env.git('rev-parse', 'HEAD')).trim();
  const code = (res: { json: <T>() => T }) => res.json<{ error: { code: string } }>().error.code;

  /**
   * A refused purge answers `status`/`errCode` and writes nothing. Each test
   * gets its own agent so the general per-account write cap (30/min) is not
   * what answers.
   */
  let checker = '';
  const refused = async (slug: string, payload: Rec, status: number, errCode: string) => {
    const before = await head();
    const res = await purge(slug, payload, bearer(checker));
    expect(res.statusCode, res.body).toBe(status);
    expect(code(res)).toBe(errCode);
    expect(await head()).toBe(before);
    const dry = await purge(slug, { ...payload, dryRun: true }, bearer(checker));
    expect(dry.statusCode, `dry run: ${dry.body}`).toBe(status);
    expect(code(dry)).toBe(errCode);
  };

  describe('who may call it', () => {
    it('only an agent with moderation:purge (others 404)', async () => {
      const payload = { reason, evidence: bioEvidence };
      expect((await purge('promo-shop', payload, bearer(voter.token))).statusCode).toBe(404);
      expect((await purge('promo-shop', payload, { cookies: { cfp_session: staff } })).statusCode).toBe(404);
      expect((await purge('promo-shop', payload, { cookies: { cfp_session: admin } })).statusCode).toBe(404);
      expect((await purge('promo-shop', payload, {})).statusCode).toBe(404);
    });
  });

  describe('the request', () => {
    it('refuses a reason with a URL in any form', async () => {
      for (const r of [
        'Bio links https://promo-shop.example/deals',
        'Bio links www.promo-shop.example',
        'Bio links promo-shop.example/deals today',
        'see ftp://files.example',
      ]) {
        const res = await purge('promo-shop', { reason: r, evidence: bioEvidence });
        expect(res.statusCode, r).toBe(422);
        expect(res.json<{ error: { fields: Record<string, string> } }>().error.fields['reason']).toMatch(/URL/);
      }
      expect(containsUrl('Advertises Promo Shop, a business unrelated to civic tech.')).toBe(false);
      expect(containsUrl('Sells via promo-shop.example')).toBe(false);
    });

    it('needs 1–5 evidence items, a reason, and good flags', async () => {
      expect((await purge('promo-shop', { reason, evidence: [] })).statusCode).toBe(422);
      expect((await purge('promo-shop', { reason, evidence: Array(6).fill(bioEvidence[0]) })).statusCode).toBe(422);
      expect((await purge('promo-shop', { reason: ' ', evidence: bioEvidence })).statusCode).toBe(422);
      expect((await purge('promo-shop', { reason, evidence: bioEvidence, flags: ['BAD FLAG'] })).statusCode).toBe(422);
      const noField = await purge('promo-shop', { reason, evidence: [{ record: 'person' }] });
      expect(noField.statusCode).toBe(422);
      expect(code(noField)).toBe('evidence_invalid');
    });
  });

  describe('case 1: a promotional bio, two minutes after sign-up', () => {
    it('a dry run passes, says what would go, and writes nothing', async () => {
      const before = await head();
      const res = await purge('promo-shop', { reason, flags: ['bio-promo-link'], evidence: bioEvidence, dryRun: true });
      expect(res.statusCode, res.body).toBe(200);
      const d = res.json<{ data: { dryRun: boolean; purge: Rec; deleted: Rec } }>().data;
      expect(d.dryRun).toBe(true);
      expect(d.purge).toMatchObject({ personSlug: 'promo-shop', by: 'agent-example-bot', githubUserId: GH_ID, blocksSignIn: true });
      expect(d.deleted).toEqual({ projects: [], memberships: 0, updates: 0, buzz: 0, helpWantedRoles: 0, rsvps: 0 });
      expect(await head()).toBe(before);
      expect(env.app.inMemoryState.personIdBySlug.has('promo-shop')).toBe(true);
    });

    it('purges in one commit, as the agent, with the reason and trailers', async () => {
      const before = await head();
      const res = await purge('promo-shop', { reason, flags: ['bio-promo-link', 'business-name'], evidence: bioEvidence });
      expect(res.statusCode, res.body).toBe(200);
      const d = res.json<{ data: { purge: Rec; dryRun: boolean } }>().data;
      expect(d.dryRun).toBe(false);
      expect(Number((await env.git('rev-list', '--count', `${before}..HEAD`)).trim())).toBe(1);

      const author = (await env.git('log', '-1', '--format=%an <%ae>')).trim();
      expect(author).toBe('Example example-bot <example-bot@users.noreply.codeforphilly.org>');
      const msg = await env.git('log', '-1', '--format=%B');
      expect(msg.split('\n')[0]).toBe('example-bot: POST /api/admin/members/promo-shop/purge');
      expect(msg).toContain(`\n${reason}\n`);
      const trailers = (
        await (async () => {
          const { execFile } = await import('node:child_process');
          return new Promise<string>((resolve, reject) => {
            const child = execFile('git', ['interpret-trailers', '--parse'], (err, out) => (err ? reject(err) : resolve(out)));
            child.stdin!.end(msg);
          });
        })()
      ).split('\n');
      expect(trailers).toEqual(
        expect.arrayContaining([
          'Action: person.purge',
          'Actor-Kind: agent',
          `Grant-Id: ${bot.grantId}`,
          `Purge-Id: ${String(d.purge['id'])}`,
          'Subject-Type: person',
          `Subject-Id: ${fid(N.promo)}`,
          'Subject-Slug: promo-shop',
          'Evidence: people/promo-shop.toml#bio',
        ]),
      );
      expect(msg).not.toContain(bot.token);
      expect(msg).not.toContain('https://');

      // The spam as it stood is one `git show <sha>^:<path>` away.
      expect(await env.git('show', 'HEAD^:people/promo-shop.toml')).toContain('Promo Shop: the best deals');
      expect(await env.git('ls-tree', '-r', '--name-only', 'HEAD', 'people/promo-shop')).toBe('');
      expect(await env.git('show', 'HEAD^:people/promo-shop/avatar.jpg')).toBeTruthy();
    });

    it('leaves a spam-purges record that blocks the GitHub account, and the agent vote as the why', async () => {
      const state = env.app.inMemoryState;
      expect(state.personIdBySlug.has('promo-shop')).toBe(false);
      const [id] = [...(state.spamPurgesByGithubUserId.get(GH_ID) ?? [])];
      const record = state.spamPurges.get(id!)!;
      expect(record).toMatchObject({
        personSlug: 'promo-shop',
        personId: fid(N.promo),
        githubUserId: GH_ID,
        by: 'agent-example-bot',
        grantId: bot.grantId,
        reason,
        flags: ['bio-promo-link', 'business-name'],
        evidence: [{ record: 'person', field: 'bio', path: 'people/promo-shop.toml' }],
        blocksSignIn: true,
      });
      expect(record.beforeCommit).toBe((await env.git('rev-parse', 'HEAD^')).trim());
      expect(await env.git('ls-tree', '--name-only', 'HEAD', `spam-purges/promo-shop/${record.id}.toml`)).toContain(record.id);
      const vote = state.personEvaluations.get('promo-shop/agent-example-bot')!;
      expect(vote).toMatchObject({ verdict: 'spam', flags: ['agent', 'purged', 'bio-promo-link', 'business-name'], reasoning: reason });
    });
  });

  describe('case 2: a site name that self-joined a real project', () => {
    it('purges them and their own records; the project and everyone else stay', async () => {
      const res = await purge('site-name', {
        reason: 'Site name as member name; bio advertises a streaming service.',
        evidence: [...bioEvidence, { record: 'project-update', project: 'real-project', number: 2 }],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ data: { deleted: Rec } }>().data.deleted).toMatchObject({ projects: [], memberships: 1, updates: 1 });
      const state = env.app.inMemoryState;
      expect(state.personIdBySlug.has('site-name')).toBe(false);
      expect(state.projectIdBySlug.has('real-project')).toBe(true);
      const left = [...(state.membershipsByProject.get('real-project') ?? [])].map((m) => state.projectMemberships.get(m)!.personSlug).sort();
      expect(left).toEqual(['co-maintainer', 'helper-hal', 'maintainer-mae', 'role-poster']);
      expect(state.updateByProjectAndNumber.has('real-project:1')).toBe(true);
      expect(state.updateByProjectAndNumber.has('real-project:2')).toBe(false);
      const msg = await env.git('log', '-1', '--format=%B');
      expect(msg).toMatch(/^Evidence: people\/site-name\.toml#bio$/m);
      expect(msg).toMatch(/^Evidence: project-updates\/real-project\/2\.toml$/m);
    });
  });

  describe('a project the member made and nobody else touched', () => {
    it('can be cited, and goes with the purge', async () => {
      const res = await purge('own-project', {
        reason: 'Created a project selling followers.',
        evidence: [{ record: 'project', project: 'spam-proj', field: 'summary' }],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ data: { deleted: { projects: Rec[] } } }>().data.deleted.projects).toEqual([
        { slug: 'spam-proj', title: 'Project spam-proj' },
      ]);
      expect(env.app.inMemoryState.projectIdBySlug.has('spam-proj')).toBe(false);
    });
  });

  describe('refusals (each writes nothing; a dry run refuses the same way)', () => {
    const payload = { reason: 'Promotional bio.', evidence: bioEvidence };
    let n = 0;
    beforeEach(async () => {
      n += 1;
      checker = (await createAgent(env, admin, { slug: `check-bot-${n}`, scopes: ['moderation:read', 'moderation:purge'] })).token;
    });

    it('rule 1: an imported member (409 protected_account), staff (409), an agent account or itself (422)', async () => {
      await refused('imported', payload, 409, 'protected_account');
      await refused('staffer', { reason: 'x', evidence: [{ record: 'project-update', project: 'real-project', number: 1 }] }, 422, 'evidence_invalid');
      expect((await purge('voter-bot', payload, bearer(checker))).statusCode).toBe(422);
      expect((await purge('check-bot-1', payload, bearer(checker))).statusCode).toBe(422);
    });

    it('rule 2: joined more than 7 days ago (409 member_too_old)', async () => {
      await refused('too-old', payload, 409, 'member_too_old');
    });

    it('rule 3: any human vote (409 human_verdict_exists)', async () => {
      await refused('human-voted', payload, 409, 'human_verdict_exists');
    });

    it('rule 4: a standing agent legit vote (409 legit_vote_exists)', async () => {
      await refused('agent-legit', payload, 409, 'legit_vote_exists');
    });

    it('rule 5: signed into Slack through the site (409 established_member)', async () => {
      await refused('slacker', payload, 409, 'established_member');
    });

    it('rule 6: created a project someone else joined, or maintains one with other members (409 shared_project)', async () => {
      await refused('shared-creator', payload, 409, 'shared_project');
      await refused('co-maintainer', payload, 409, 'shared_project');
    });

    it('evidence that is empty or not theirs (422 evidence_invalid)', async () => {
      await refused('empty-bio', payload, 422, 'evidence_invalid');
      await refused(
        'role-poster',
        { reason: 'Promo update.', evidence: [{ record: 'project-update', project: 'real-project', number: 1 }] },
        422,
        'evidence_invalid',
      );
      await refused('role-poster', { reason: 'x', evidence: [{ record: 'project', project: 'real-project' }] }, 422, 'evidence_invalid');
    });

    it('rule 7: evidence on a project the purge keeps (409 evidence_survives)', async () => {
      await refused(
        'role-poster',
        { reason: 'Posted a role advertising a shop.', evidence: [{ record: 'help-wanted-role', project: 'real-project', roleId: ROLE_ID }] },
        409,
        'evidence_survives',
      );
    });
  });

  describe('rule 8: volume', () => {
    it('five purges per agent per 24 hours; the sixth is 429 with Retry-After', async () => {
      const burst = await createAgent(env, admin, {
        slug: 'burst-bot',
        scopes: ['moderation:read', 'moderation:purge'],
      });
      for (let i = 0; i < 5; i++) {
        const res = await purge(`burst-${i}`, { reason: 'Promotional bio.', evidence: bioEvidence }, bearer(burst.token));
        expect(res.statusCode, res.body).toBe(200);
      }
      const before = await head();
      const res = await purge('burst-5', { reason: 'Promotional bio.', evidence: bioEvidence }, bearer(burst.token));
      expect(res.statusCode).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(23 * 3600);
      expect(await head()).toBe(before);
      const list = await env.app.inject({ method: 'GET', url: '/api/admin/agents', cookies: { cfp_session: staff } });
      const row = list.json<{ data: Array<{ person: { slug: string }; purges: Rec }> }>().data.find((a) => a.person.slug === 'burst-bot')!;
      expect(row.purges).toEqual({ last24h: 5, last30d: 5 });
    }, 60_000);
  });
});
