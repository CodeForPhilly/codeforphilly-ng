/**
 * Votes belong to one account — specs/api/moderation.md → "Votes belong to
 * one account". A person-evaluation whose `evaluatedAt` is earlier than the
 * person's `createdAt` was cast on an earlier account under the same slug
 * (purged since) and counts for nothing on the new one: not the roster's
 * latest vote, not the reversal rule, not the scheduled purge. The detail
 * response lists it apart, as `earlierVotes`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { queuedForSpamPurge, spamPurgeDueAt } from '../src/services/spam-purge.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const STAFF_ID = '01951a3c-0000-7000-8000-0000000001a1';
const REBORN_ID = '01951a3c-0000-7000-8000-0000000001b1';
/** A long-standing member who holds a slug a spam account was purged under. */
const VETERAN_ID = '01951a3c-0000-7000-8000-0000000001c1';
const PURGED_ID = '01951a3c-0000-7000-8000-0000000001c2';
const PURGE_RECORD_ID = '01951a3c-0000-7000-8000-0000000001c3';
const MOVER_ID = '01951a3c-0000-7000-8000-0000000001d1';
const VETERAN_CREATED_AT = '2025-03-01T00:00:00Z';
/** Cast on the purged account: after the veteran's createdAt, before the purge. */
const PURGED_ACCOUNT_VOTE_AT = '2026-10-04T12:00:00Z';
const PURGED_AT = '2026-10-05T00:00:00Z';

/** The earlier account's staff vote, cast before `reborn` signed up again. */
const EARLIER_VOTE_AT = '2026-10-01T12:00:00Z';
const REBORN_CREATED_AT = '2026-10-02T09:00:00Z';

describe('votes belong to one account', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  let staffCookie: string;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    const person = (slug: string, id: string, level: string, createdAt: string, deletedAt?: string) =>
      [
        `id = "${id}"`,
        `slug = "${slug}"`,
        `fullName = "Test ${slug}"`,
        `accountLevel = "${level}"`,
        deletedAt ? `deletedAt = "${deletedAt}"` : '',
        `createdAt = "${createdAt}"`,
        `updatedAt = "${createdAt}"`,
      ].filter(Boolean).join('\n');
    await seedRawToml(dataRepo.path, 'people/staffer.toml', person('staffer', STAFF_ID, 'staff', '2026-01-01T00:00:00Z'), 'seed staffer');
    // Deactivated by themselves, long after signing up again.
    await seedRawToml(
      dataRepo.path,
      'people/reborn.toml',
      person('reborn', REBORN_ID, 'user', REBORN_CREATED_AT, '2026-10-03T00:00:00Z'),
      'seed reborn',
    );
    await seedRawToml(
      dataRepo.path,
      'person-evaluations/reborn/human-staffer.toml',
      [
        `personSlug = "reborn"`,
        `evaluator = "human-staffer"`,
        `verdict = "spam"`,
        `confidence = 1`,
        `flags = ["manual-override"]`,
        `reasoning = "earlier account: promo bio"`,
        `evaluatedAt = "${EARLIER_VOTE_AT}"`,
      ].join('\n'),
      'seed earlier vote',
    );

    // `veteran` signed up long ago; a spam account under the same slug was
    // voted on and purged later (as it would be had the veteran renamed onto
    // the freed slug before renames onto it were refused).
    await seedRawToml(dataRepo.path, 'people/veteran.toml', person('veteran', VETERAN_ID, 'user', VETERAN_CREATED_AT), 'seed veteran');
    await seedRawToml(
      dataRepo.path,
      'person-evaluations/veteran/human-staffer.toml',
      [
        `personSlug = "veteran"`,
        `evaluator = "human-staffer"`,
        `verdict = "spam"`,
        `confidence = 1`,
        `flags = ["manual-override"]`,
        `reasoning = "purged account: promo bio"`,
        `evaluatedAt = "${PURGED_ACCOUNT_VOTE_AT}"`,
      ].join('\n'),
      'seed vote on the purged account',
    );
    const purgeRecord = (slug: string, id: string) =>
      [
        `id = "${id}"`,
        `personSlug = "${slug}"`,
        `personId = "${PURGED_ID}"`,
        `purgedAt = "${PURGED_AT}"`,
        `by = "human-staffer"`,
        `reason = "Promotional bio."`,
        `flags = []`,
        `evidence = []`,
        `beforeCommit = "0000000000000000000000000000000000000000"`,
        `blocksSignIn = true`,
      ].join('\n');
    await seedRawToml(dataRepo.path, `spam-purges/veteran/${PURGE_RECORD_ID}.toml`, purgeRecord('veteran', PURGE_RECORD_ID), 'seed purge record');
    // Slugs with moderation history and no person: one with only a vote, one
    // with only a purge record.
    await seedRawToml(
      dataRepo.path,
      'person-evaluations/voted-gone/human-staffer.toml',
      [
        `personSlug = "voted-gone"`,
        `evaluator = "human-staffer"`,
        `verdict = "spam"`,
        `confidence = 1`,
        `flags = ["manual-override"]`,
        `evaluatedAt = "${PURGED_ACCOUNT_VOTE_AT}"`,
      ].join('\n'),
      'seed vote on a purged slug',
    );
    await seedRawToml(
      dataRepo.path,
      'spam-purges/purged-gone/01951a3c-0000-7000-8000-0000000001c4.toml',
      purgeRecord('purged-gone', '01951a3c-0000-7000-8000-0000000001c4'),
      'seed purge record on a free slug',
    );
    await seedRawToml(dataRepo.path, 'people/mover.toml', person('mover', MOVER_ID, 'user', VETERAN_CREATED_AT), 'seed mover');

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
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  const staff = () => ({ cookies: { cfp_session: staffCookie } });

  describe('a vote at or before a purge of the slug that named another person', () => {
    it('does not count on a member who existed before the purge', async () => {
      const row = (await app.inject({ method: 'GET', url: '/api/admin/members?vote=none', ...staff() }))
        .json<{ data: Array<{ slug: string; latestVote: unknown }> }>()
        .data.find((r) => r.slug === 'veteran');
      expect(row).toBeDefined();
      expect(row!.latestVote).toBeNull();

      const detail = await app.inject({ method: 'GET', url: '/api/admin/members/veteran', ...staff() });
      const d = detail.json<{ data: { votes: unknown[]; earlierVotes: Array<{ reasoning: string }> } }>().data;
      expect(d.votes).toEqual([]);
      expect(d.earlierVotes).toEqual([expect.objectContaining({ reasoning: 'purged account: promo bio' })]);
    });

    it('a vote after the purge counts', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/admin/members/veteran/vote', payload: { verdict: 'legit' }, ...staff() });
      expect(res.statusCode, res.body).toBe(200);
      const d = (await app.inject({ method: 'GET', url: '/api/admin/members/veteran', ...staff() })).json<{
        data: { votes: Array<{ verdict: string }> };
      }>().data;
      expect(d.votes.map((v) => v.verdict)).toEqual(['legit']);
    });
  });

  describe('a rename onto a slug with moderation history', () => {
    const rename = async (cookie: string, to: string) =>
      app.inject({ method: 'PATCH', url: '/api/people/mover', payload: { slug: to }, cookies: { cfp_session: cookie } });

    it('is refused for the member and for staff (422 slug_retired)', async () => {
      const self = (await mintSessionFor(MOVER_ID, 'user', JWT_KEY)).accessToken;
      for (const cookie of [self, staffCookie]) {
        for (const to of ['voted-gone', 'purged-gone']) {
          const res = await rename(cookie, to);
          expect(res.statusCode, `${to}: ${res.body}`).toBe(422);
          expect(res.json<{ error: { fields: Record<string, string> } }>().error.fields['slug']).toBe('slug_retired');
        }
      }
      expect(app.inMemoryState.personIdBySlug.get('mover')).toBe(MOVER_ID);
    });

    it('a slug with no history is still free', async () => {
      const res = await rename(staffCookie, 'mover-two');
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  it('the roster shows no latest vote and counts the member as unvoted', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/members?vote=none', ...staff() });
    const row = res.json<{ data: Array<{ slug: string; latestVote: unknown; purgeAfter: unknown }> }>().data.find(
      (r) => r.slug === 'reborn',
    );
    expect(row).toBeDefined();
    expect(row!.latestVote).toBeNull();
    expect(row!.purgeAfter).toBeNull();

    const spam = await app.inject({ method: 'GET', url: '/api/admin/members?vote=spam', ...staff() });
    expect(spam.json<{ data: Array<{ slug: string }> }>().data.map((r) => r.slug)).not.toContain('reborn');
  });

  it('the detail lists the vote under earlierVotes, not votes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/members/reborn', ...staff() });
    expect(res.statusCode).toBe(200);
    const d = res.json<{ data: { votes: unknown[]; earlierVotes: Array<{ verdict: string; reasoning: string; evaluatedAt: string }> } }>().data;
    expect(d.votes).toEqual([]);
    expect(d.earlierVotes).toHaveLength(1);
    expect(d.earlierVotes[0]).toMatchObject({ verdict: 'spam', reasoning: 'earlier account: promo bio' });
  });

  it('is never queued for the scheduled purge, though deactivated', () => {
    const state = app.inMemoryState;
    const reborn = state.people.get(REBORN_ID)!;
    expect(reborn.deletedAt).toBeTruthy();
    expect(spamPurgeDueAt(state, reborn)).toBeNull();
    expect(queuedForSpamPurge(state, new Date('2027-01-01T00:00:00Z')).map((p) => p.slug)).not.toContain('reborn');
  });

  it('a Not spam vote does not undo their own deactivation (no spam vote of this account to reverse)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/members/reborn/vote',
      payload: { verdict: 'legit' },
      ...staff(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { person: { deletedAt: string | null }; latestVote: { verdict: string } } }>().data;
    expect(body.person.deletedAt).not.toBeNull();
    expect(body.latestVote.verdict).toBe('legit');
  });
});
