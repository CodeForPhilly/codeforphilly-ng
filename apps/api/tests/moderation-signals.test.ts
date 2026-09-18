/**
 * Row-local signals and the GitHub probe — specs/api/moderation.md "Field notes".
 *
 *  - emailMatchesName / countLinks edge cases
 *  - computeSignals: the spam shape counts toward attention; positives don't
 *  - refreshGitHubFacts: probes only stale linked accounts, persists ok/gone,
 *    keeps the old record on failure, bounded by TTL
 */
import { describe, expect, it } from 'vitest';
import { PersonSchema, type Person, type PrivateProfile } from '@cfp/shared/schemas';
import type { PrivateStore } from '../src/store/private/interface.js';
import { createEmptyState, indexPerson } from '../src/store/memory/state.js';
import {
  ModerationService,
  computeSignals,
  countLinks,
  emailMatchesName,
  type GitHubProbe,
} from '../src/services/moderation.js';

function person(overrides: Partial<Person> & { id: string; slug: string }): Person {
  return PersonSchema.parse({
    fullName: `Test ${overrides.slug}`,
    accountLevel: 'user',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  });
}

/** Just enough of PrivateStore for the moderation service. */
function fakePrivateStore(seed: PrivateProfile[]): PrivateStore & { profiles: Map<string, PrivateProfile> } {
  const profiles = new Map(seed.map((p) => [p.personId, p]));
  return {
    profiles,
    getProfile: async (id: string) => profiles.get(id) ?? null,
    putProfile: async (p: PrivateProfile) => {
      profiles.set(p.personId, p);
    },
  } as unknown as PrivateStore & { profiles: Map<string, PrivateProfile> };
}

function profile(personId: string, extra: Partial<PrivateProfile> = {}): PrivateProfile {
  return {
    personId,
    email: 'someone@example.org',
    emailRefreshedAt: '2026-09-01T00:00:00Z',
    newsletter: null,
    updatedAt: '2026-09-01T00:00:00Z',
    ...extra,
  };
}

const NO_FOOTPRINT = { memberships: 0, updates: 0, buzz: 0, blogPosts: 0, helpWantedInterest: 0, tags: 0 };

describe('emailMatchesName', () => {
  it('matches when the local part contains a name token', () => {
    expect(emailMatchesName('stacey.villarreal@mail.com', 'Stacey Villarreal')).toBe(true);
    expect(emailMatchesName('jdoe@example.org', 'Jane Doe')).toBe(true);
  });
  it('flags a local part unrelated to the name', () => {
    expect(emailMatchesName('benjamin_cox8mzr@mail.com', 'Stacey Villarreal')).toBe(false);
  });
  it('is undecided without an email or with only short name tokens', () => {
    expect(emailMatchesName(null, 'Stacey Villarreal')).toBeNull();
    expect(emailMatchesName('x@example.org', 'JT Li')).toBeNull();
  });
});

describe('countLinks', () => {
  it('counts URLs and markdown/html links', () => {
    expect(countLinks('Visit https://a.example and [me](https://b.example) or www.c.example')).toBe(4);
    expect(countLinks('no links here')).toBe(0);
    expect(countLinks(null)).toBe(0);
  });
});

describe('computeSignals', () => {
  it('scores the throwaway shape and leaves an established member plain', () => {
    const throwaway = computeSignals({
      person: person({ id: '01951a3c-0000-7000-8000-000000000101', slug: 'ceoviedeopu1972', fullName: 'Stacey Villarreal', bio: 'Buy https://x.example' }),
      email: 'benjamin_cox8mzr@mail.com',
      signInCount: 0,
      github: null,
      emailBounce: null,
      lastSlackSsoAt: null,
      footprint: NO_FOOTPRINT,
    });
    expect(throwaway.signals).toEqual(['never-signed-in', 'no-avatar', 'bio-links:1', 'email-name-mismatch']);
    expect(throwaway.attention).toBe(4);

    const established = computeSignals({
      person: person({ id: '01951a3c-0000-7000-8000-000000000102', slug: 'jane', fullName: 'Jane Doe', bio: 'Civic hacker', avatarKey: 'people/jane/avatar.jpg' }),
      email: 'jane.doe@example.org',
      signInCount: 12,
      github: { login: 'janedoe', accountCreatedAt: '2015-01-01T00:00:00Z', publicRepos: 20, followers: 30, status: 'ok', checkedAt: '2026-09-18T00:00:00Z' },
      emailBounce: null,
      lastSlackSsoAt: '2026-09-18T00:00:00Z',
      footprint: { ...NO_FOOTPRINT, memberships: 2 },
    });
    expect(established.signals).toEqual(['slack-sso', 'has-footprint']);
    expect(established.attention).toBe(0);
  });

  it('flags gone, new, and inactive GitHub accounts and bounced email', () => {
    const r = computeSignals({
      person: person({ id: '01951a3c-0000-7000-8000-000000000103', slug: 'newgh', bio: 'hi', avatarKey: 'x' }),
      email: 'newgh@example.org',
      signInCount: 1,
      github: { login: 'newgh', accountCreatedAt: new Date().toISOString(), publicRepos: 0, followers: 0, status: 'gone', checkedAt: '2026-09-18T00:00:00Z' },
      emailBounce: { type: 'HardBounce' },
      lastSlackSsoAt: null,
      footprint: NO_FOOTPRINT,
    });
    expect(r.signals).toEqual(['email-bounced:HardBounce', 'github-gone', 'github-new-account', 'github-no-activity']);
    expect(r.attention).toBe(4);
  });
});

describe('ModerationService.refreshGitHubFacts', () => {
  const LINKED = '01951a3c-0000-7000-8000-000000000201';
  const STALE = '01951a3c-0000-7000-8000-000000000202';
  const UNLINKED = '01951a3c-0000-7000-8000-000000000203';
  const FRESH = '01951a3c-0000-7000-8000-000000000204';

  function setup(probe: GitHubProbe) {
    const state = createEmptyState();
    const people = [
      person({ id: LINKED, slug: 'linked', githubUserId: 1001, githubLogin: 'linked' }),
      person({ id: STALE, slug: 'stale', githubUserId: 1002, githubLogin: 'stale' }),
      person({ id: UNLINKED, slug: 'unlinked' }),
      person({ id: FRESH, slug: 'fresh', githubUserId: 1004, githubLogin: 'fresh' }),
    ];
    for (const p of people) indexPerson(state, p);
    const store = fakePrivateStore([
      profile(LINKED),
      profile(STALE, {
        github: { login: 'stale', accountCreatedAt: '2020-01-01T00:00:00Z', publicRepos: 3, followers: 1, following: 0, type: 'User', status: 'ok', checkedAt: '2026-09-01T00:00:00Z' },
      }),
      profile(UNLINKED),
      profile(FRESH, {
        github: { login: 'fresh', accountCreatedAt: '2020-01-01T00:00:00Z', publicRepos: 3, followers: 1, following: 0, type: 'User', status: 'ok', checkedAt: new Date().toISOString() },
      }),
    ]);
    const service = new ModerationService(state, store, () => ({ lastLoginAt: null, count: 0 }), { probe });
    return { state, store, service, people };
  }

  it('probes only stale linked accounts and persists ok / gone', async () => {
    const probed: number[] = [];
    const { store, service, people } = setup(async (id) => {
      probed.push(id);
      if (id === 1002) return { status: 'gone', user: null };
      return {
        status: 'ok',
        user: { id, login: `gh${id}`, name: null, created_at: '2018-05-05T00:00:00Z', public_repos: 7, followers: 2, following: 1, type: 'User' },
      };
    });
    await service.refreshGitHubFacts(people);
    expect(probed.sort()).toEqual([1001, 1002]); // not 1003 (unlinked), not 1004 (fresh)
    expect(store.profiles.get(LINKED)?.github).toMatchObject({ login: 'gh1001', status: 'ok', publicRepos: 7, accountCreatedAt: '2018-05-05T00:00:00Z' });
    expect(store.profiles.get(STALE)?.github).toMatchObject({ login: 'stale', status: 'gone', publicRepos: 3 });
    expect(store.profiles.get(FRESH)?.github?.status).toBe('ok');
  });

  it('keeps the previous record when the probe fails', async () => {
    const { store, service, people } = setup(async () => {
      throw new Error('rate limited');
    });
    await service.refreshGitHubFacts(people);
    expect(store.profiles.get(STALE)?.github?.checkedAt).toBe('2026-09-01T00:00:00Z');
    expect(store.profiles.get(LINKED)?.github ?? null).toBeNull();
  });
});
