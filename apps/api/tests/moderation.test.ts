/**
 * Moderation API — specs/api/moderation.md, specs/behaviors/person-lifecycle.md.
 *
 * Covers:
 *  - every endpoint 404s for anonymous and ordinary users (existence is not a signal)
 *  - the roster lists members newest first with staff-visible email and vote state
 *  - a spam vote records `human-<voter>` and deactivates in the same transaction
 *  - a legit vote after a spam vote reactivates; after a self-deactivation it does not
 *  - re-voting replaces the caller's record; self-votes are rejected
 *  - the `vote` filter and the detail endpoint's footprint + vote history
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';

const STAFF_ID = '01951a3c-0000-7000-8000-0000000000a1';
const ADMIN_ID = '01951a3c-0000-7000-8000-0000000000a2';
const USER_ID = '01951a3c-0000-7000-8000-0000000000b1';
const NEW_ID = '01951a3c-0000-7000-8000-0000000000b2';
const SELFOFF_ID = '01951a3c-0000-7000-8000-0000000000b3';

async function seedPerson(
  repoDir: string,
  opts: { slug: string; id: string; accountLevel?: string; createdAt: string; deletedAt?: string; bio?: string; githubUserId?: number },
): Promise<void> {
  const lines = [
    `id = "${opts.id}"`,
    `slug = "${opts.slug}"`,
    `fullName = "Test ${opts.slug}"`,
    `accountLevel = "${opts.accountLevel ?? 'user'}"`,
    opts.bio ? `bio = "${opts.bio}"` : '',
    typeof opts.githubUserId === 'number' ? `githubUserId = ${opts.githubUserId}` : '',
    opts.deletedAt ? `deletedAt = "${opts.deletedAt}"` : '',
    `createdAt = "${opts.createdAt}"`,
    `updatedAt = "${opts.createdAt}"`,
  ].filter(Boolean);
  await seedRawToml(repoDir, `people/${opts.slug}.toml`, lines.join('\n'), `seed person ${opts.slug}`);
}

describe('moderation API', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  let staffCookie: string;
  let adminCookie: string;
  let userCookie: string;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, { slug: 'staffer', id: STAFF_ID, accountLevel: 'staff', createdAt: '2026-01-01T00:00:00Z' });
    await seedPerson(dataRepo.path, { slug: 'boss', id: ADMIN_ID, accountLevel: 'administrator', createdAt: '2026-01-02T00:00:00Z' });
    await seedPerson(dataRepo.path, { slug: 'regular', id: USER_ID, createdAt: '2026-02-01T00:00:00Z', githubUserId: 42 });
    await seedPerson(dataRepo.path, { slug: 'newest', id: NEW_ID, createdAt: '2026-09-01T00:00:00Z', bio: 'Buy **cheap** [pills](https://x.example) now' });
    await seedPerson(dataRepo.path, { slug: 'selfoff', id: SELFOFF_ID, createdAt: '2026-03-01T00:00:00Z', deletedAt: '2026-04-01T00:00:00Z' });

    const profiles = [
      { personId: NEW_ID, email: 'newest@example.org' },
      { personId: USER_ID, email: 'regular@example.org' },
    ].map((p) =>
      JSON.stringify({
        ...p,
        emailRefreshedAt: '2026-05-01T00:00:00.000Z',
        newsletter: { optedIn: false, optedInAt: null, optedOutAt: null, unsubscribeToken: null },
        updatedAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    await writeFile(join(privateStore.path, 'profiles.jsonl'), profiles.join('\n') + '\n');

    app = await buildApp({
      serverOptions: { logger: false },
      overrideEnv: {
        CFP_DATA_REPO_PATH: dataRepo.path,
        STORAGE_BACKEND: 'filesystem',
        CFP_PRIVATE_STORAGE_PATH: privateStore.path,
        CFP_JWT_SIGNING_KEY: JWT_KEY,
        NODE_ENV: 'test',
      },
    });

    staffCookie = (await mintSessionFor(STAFF_ID, 'staff', JWT_KEY)).accessToken;
    adminCookie = (await mintSessionFor(ADMIN_ID, 'administrator', JWT_KEY)).accessToken;
    userCookie = (await mintSessionFor(USER_ID, 'user', JWT_KEY)).accessToken;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  const asStaff = (cookie: string) => ({ cookies: { cfp_session: cookie } });

  it('404s for anonymous and ordinary users on all three endpoints', async () => {
    for (const cookies of [{}, asStaff(userCookie)]) {
      const list = await app.inject({ method: 'GET', url: '/api/admin/members', ...cookies });
      expect(list.statusCode).toBe(404);
      const detail = await app.inject({ method: 'GET', url: '/api/admin/members/newest', ...cookies });
      expect(detail.statusCode).toBe(404);
      const vote = await app.inject({
        method: 'POST',
        url: '/api/admin/members/newest/vote',
        payload: { verdict: 'spam' },
        ...cookies,
      });
      expect(vote.statusCode).toBe(404);
    }
  });

  it('lists members newest first with staff-visible fields and no vote yet', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/members', ...asStaff(staffCookie) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<Record<string, unknown>>; metadata: { totalItems: number } }>();
    expect(body.metadata.totalItems).toBe(5);
    expect(body.data[0]?.['slug']).toBe('newest');
    const newest = body.data[0]!;
    expect(newest['email']).toBe('newest@example.org');
    expect(newest['latestVote']).toBeNull();
    expect(newest['bioExcerpt']).toBe('Buy cheap pills now');
    const regular = body.data.find((r) => r['slug'] === 'regular')!;
    expect(regular['hasGitHubLink']).toBe(true);
    // Deactivated members are included by default — moderation needs to see what it hid.
    expect(body.data.some((r) => r['slug'] === 'selfoff')).toBe(true);
  });

  it('spam vote records human-<voter> and deactivates in the same transaction', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/members/newest/vote',
      payload: { verdict: 'spam', reasoning: 'pharma bio' },
      ...asStaff(staffCookie),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { person: { deletedAt: string | null }; vote: { evaluator: string; confidence: number }; latestVote: { verdict: string; voter: { slug: string } } } }>();
    expect(body.data.vote.evaluator).toBe('human-staffer');
    expect(body.data.vote.confidence).toBe(1);
    expect(body.data.person.deletedAt).not.toBeNull();
    expect(body.data.latestVote.verdict).toBe('spam');
    expect(body.data.latestVote.voter.slug).toBe('staffer');

    // Hidden from the public detail endpoint now.
    const pub = await app.inject({ method: 'GET', url: '/api/people/newest' });
    expect(pub.statusCode).toBe(404);

    // The record landed on the data repo as a committed file, authored by the voter.
    const tree = await execFileAsync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'person-evaluations/'], {
      cwd: dataRepo.path,
    });
    expect(tree.stdout.trim().split('\n')).toEqual(['person-evaluations/newest/human-staffer.toml']);
    const author = await execFileAsync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: dataRepo.path });
    expect(author.stdout.trim()).toBe('Test staffer <staffer@users.noreply.codeforphilly.org>');
  });

  it('vote filter and detail endpoint expose the vote history and footprint', async () => {
    const spamOnly = await app.inject({ method: 'GET', url: '/api/admin/members?vote=spam', ...asStaff(adminCookie) });
    expect(spamOnly.json<{ data: Array<{ slug: string }> }>().data.map((r) => r.slug)).toEqual(['newest']);

    const none = await app.inject({ method: 'GET', url: '/api/admin/members?vote=none', ...asStaff(adminCookie) });
    expect(none.json<{ data: Array<{ slug: string }> }>().data.map((r) => r.slug)).not.toContain('newest');

    const detail = await app.inject({ method: 'GET', url: '/api/admin/members/newest', ...asStaff(adminCookie) });
    expect(detail.statusCode).toBe(200);
    const d = detail.json<{ data: { person: { slug: string; email: string | null }; footprint: Record<string, unknown[]>; votes: Array<{ verdict: string; reasoning: string | null }> } }>().data;
    expect(d.person.slug).toBe('newest');
    expect(d.person.email).toBe('newest@example.org');
    expect(d.footprint.memberships).toEqual([]);
    expect(d.votes).toHaveLength(1);
    expect(d.votes[0]).toMatchObject({ verdict: 'spam', reasoning: 'pharma bio' });
  });

  it('a legit vote after a spam vote reactivates; re-voting replaces the record', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/members/newest/vote',
      payload: { verdict: 'legit' },
      ...asStaff(staffCookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { person: { deletedAt: string | null } } }>().data.person.deletedAt).toBeNull();

    const detail = await app.inject({ method: 'GET', url: '/api/admin/members/newest', ...asStaff(staffCookie) });
    const votes = detail.json<{ data: { votes: Array<{ verdict: string; voter: { slug: string } }> } }>().data.votes;
    expect(votes).toHaveLength(1);
    expect(votes[0]).toMatchObject({ verdict: 'legit', voter: { slug: 'staffer' } });
  });

  it('a legit vote never undoes a self-deactivation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/members/selfoff/vote',
      payload: { verdict: 'legit' },
      ...asStaff(adminCookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { person: { deletedAt: string | null } } }>().data.person.deletedAt).not.toBeNull();
  });

  it('rejects voting on your own account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/members/staffer/vote',
      payload: { verdict: 'legit' },
      ...asStaff(staffCookie),
    });
    expect(res.statusCode).toBe(422);
  });

  it('search matches an email substring without an @, across the whole roster', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/members?q=regular%40example', ...asStaff(staffCookie) });
    expect(res.json<{ data: Array<{ slug: string }> }>().data.map((r) => r.slug)).toEqual(['regular']);
    const bare = await app.inject({ method: 'GET', url: '/api/admin/members?q=example.org', ...asStaff(staffCookie) });
    const slugs = bare.json<{ data: Array<{ slug: string }> }>().data.map((r) => r.slug).sort();
    expect(slugs).toEqual(['newest', 'regular']);
  });

  it('rejects an unknown sort key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/members?sort=bogus', ...asStaff(staffCookie) });
    expect(res.statusCode).toBe(422);
  });
});
