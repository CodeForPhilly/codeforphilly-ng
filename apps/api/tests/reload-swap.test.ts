/**
 * Unit tests for `swapInPlace` — the in-place Map replacement behind the
 * hot-reload webhook (specs/behaviors/storage.md#hot-reload → Atomicity).
 *
 * The regression this guards: `swapInPlace` used to name each field of
 * `InMemoryState` by hand and skipped `projectIdByLegacyId`,
 * `buzzIdBySlug`, and `slugHistory`. Because the laddr importer mints
 * fresh ids every run, a re-import + hot reload left legacy redirects
 * pointing at project ids that no longer existed. These tests enumerate
 * every own property of a fresh state so a newly added collection can't
 * be silently skipped again.
 */
import { describe, expect, it } from 'vitest';
import type {
  BlogPost,
  HelpWantedInterestExpression,
  HelpWantedRole,
  Person,
  Project,
  ProjectBuzz,
  ProjectMembership,
  ProjectUpdate,
  SlugHistory,
  Tag,
  TagAssignment,
} from '@cfp/shared/schemas';

import { swapInPlace } from '../src/store/memory/reload.js';
import {
  createEmptyState,
  indexBlogPost,
  indexHelpWantedInterest,
  indexHelpWantedRole,
  indexMembership,
  indexPerson,
  indexProject,
  indexProjectBuzz,
  indexProjectUpdate,
  indexSlugHistory,
  indexTag,
  indexTagAssignment,
  slugHistoryKey,
  type InMemoryState,
} from '../src/store/memory/state.js';

const NOW = '2026-06-01T00:00:00Z';
const FAR_FUTURE = '2099-01-01T00:00:00Z';

function uuid(n: number): string {
  return `01951a3c-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

function makeProject(n: number, slug: string, legacyId: number): Project {
  return {
    id: uuid(n),
    legacyId,
    slug,
    title: slug,
    summary: null,
    overview: null,
    stage: 'prototyping',
    maintainerId: null,
    featured: false,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makePerson(n: number, slug: string): Person {
  return {
    id: uuid(n),
    slug,
    fullName: slug,
    accountLevel: 'user',
    createdAt: NOW,
    updatedAt: NOW,
  } as Person;
}

function makeBuzz(n: number, projectId: string, slug: string): ProjectBuzz {
  return {
    id: uuid(n),
    projectId,
    slug,
    headline: slug,
    url: `https://example.test/${slug}`,
    publishedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeTag(n: number, slug: string): Tag {
  return { id: uuid(n), namespace: 'tech', slug, title: slug, createdAt: NOW, updatedAt: NOW };
}

function makeAssignment(n: number, tagId: string, projectId: string): TagAssignment {
  return { id: uuid(n), tagId, taggableType: 'project', taggableId: projectId, createdAt: NOW };
}

/**
 * The remaining entity types only need the fields their index helpers read
 * (ids + foreign keys). Cast rather than spell out every schema field —
 * this test is about index bookkeeping, not record validation.
 */
function makeMembership(n: number, projectId: string, personId: string): ProjectMembership {
  return { id: uuid(n), projectId, personId, role: 'member', createdAt: NOW, updatedAt: NOW } as unknown as ProjectMembership;
}

function makeUpdate(n: number, projectId: string, number: number): ProjectUpdate {
  return { id: uuid(n), projectId, number, createdAt: NOW, updatedAt: NOW } as unknown as ProjectUpdate;
}

function makeBlogPost(n: number, slug: string, legacyId: number): BlogPost {
  return { id: uuid(n), slug, legacyId, createdAt: NOW, updatedAt: NOW } as unknown as BlogPost;
}

function makeRole(n: number, projectId: string): HelpWantedRole {
  return { id: uuid(n), projectId, createdAt: NOW, updatedAt: NOW } as unknown as HelpWantedRole;
}

function makeInterest(n: number, roleId: string, personId: string): HelpWantedInterestExpression {
  return { id: uuid(n), roleId, personId, createdAt: NOW } as unknown as HelpWantedInterestExpression;
}

function makeSlugHistory(n: number, entityId: string, oldSlug: string, newSlug: string): SlugHistory {
  return {
    id: uuid(n),
    entityType: 'project',
    entityId,
    oldSlug,
    newSlug,
    changedAt: NOW,
    expiresAt: FAR_FUTURE,
  };
}

/**
 * Build a state holding one record of every entity type, with ids drawn
 * from `base + n`. Two calls with different bases model "before" and
 * "after a re-import that minted fresh ids": every collection differs.
 */
function buildState(base: number, slugs: { project: string; buzz: string; oldSlug: string }): InMemoryState {
  const state = createEmptyState();
  const project = makeProject(base + 1, slugs.project, 42);
  const person = makePerson(base + 2, 'jane');
  const tag = makeTag(base + 4, 'flutter');
  const role = makeRole(base + 9, project.id);

  indexProject(state, project);
  indexPerson(state, person);
  indexProjectBuzz(state, makeBuzz(base + 3, project.id, slugs.buzz));
  indexTag(state, tag);
  indexTagAssignment(state, makeAssignment(base + 5, tag.id, project.id));
  indexMembership(state, makeMembership(base + 6, project.id, person.id));
  indexProjectUpdate(state, makeUpdate(base + 7, project.id, 1));
  indexBlogPost(state, makeBlogPost(base + 8, `${slugs.project}-post`, 7));
  indexHelpWantedRole(state, role);
  indexHelpWantedInterest(state, makeInterest(base + 10, role.id, person.id));
  indexSlugHistory(state, makeSlugHistory(base + 11, project.id, slugs.oldSlug, slugs.project));
  return state;
}

/** "Before" state: ids in the 1xx range, project slug alpha-v1. */
function buildLiveState(): InMemoryState {
  return buildState(100, { project: 'alpha-v1', buzz: 'alpha-launch', oldSlug: 'alpha-v0' });
}

/**
 * "After re-import" state: freshly minted ids (2xx range), renamed project
 * slug, a different buzz slug, and a slug-history entry pointing at the new
 * slug. Same legacy ids as the live state — that's the real-world shape.
 */
function buildFreshState(): InMemoryState {
  return buildState(200, { project: 'alpha-v2', buzz: 'alpha-relaunch', oldSlug: 'alpha-v1' });
}

describe('swapInPlace', () => {
  it('replaces every collection on the live state with the fresh contents', () => {
    const live = buildLiveState();
    const fresh = buildFreshState();
    const keys = Object.keys(fresh) as (keyof InMemoryState)[];

    // Sanity: the fixture must actually exercise every field, otherwise a
    // skipped field would trivially "match".
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(fresh[key], `fresh.${key} is empty — extend the fixture`).not.toEqual(live[key]);
    }

    swapInPlace(live, fresh);

    for (const key of keys) {
      expect(live[key], `live.${key} was not replaced`).toEqual(fresh[key]);
    }
    // Also catch fields present on live but somehow absent on fresh.
    expect(Object.keys(live).sort()).toEqual(keys.sort());
  });

  it('preserves the identity of the state object and of every Map', () => {
    const live = buildLiveState();
    const fresh = buildFreshState();
    const before = new Map(
      (Object.keys(live) as (keyof InMemoryState)[]).map((k) => [k, live[k]]),
    );

    swapInPlace(live, fresh);

    for (const [key, map] of before) {
      expect(live[key], `live.${key} Map identity changed`).toBe(map);
    }
  });

  it('re-points the legacy-id, buzz-by-slug, and slug-history indices at the new records', () => {
    const live = buildLiveState();
    const fresh = buildFreshState();
    const oldProjectId = uuid(101);
    const newProjectId = uuid(201);

    expect(live.projectIdByLegacyId.get(42)).toBe(oldProjectId);
    expect(live.buzzIdBySlug.get('alpha-launch')).toBe(uuid(103));
    expect(live.slugHistory.get(slugHistoryKey('project', 'alpha-v0'))?.newSlug).toBe('alpha-v1');

    swapInPlace(live, fresh);

    // Legacy redirect path: legacyId → projectId → slug must resolve
    // end-to-end against the new records.
    expect(live.projectIdByLegacyId.get(42)).toBe(newProjectId);
    expect(live.projectSlugById.get(live.projectIdByLegacyId.get(42) as string)).toBe('alpha-v2');

    expect(live.buzzIdBySlug.get('alpha-launch')).toBeUndefined();
    expect(live.buzzIdBySlug.get('alpha-relaunch')).toBe(uuid(203));

    expect(live.slugHistory.get(slugHistoryKey('project', 'alpha-v0'))).toBeUndefined();
    expect(live.slugHistory.get(slugHistoryKey('project', 'alpha-v1'))?.newSlug).toBe('alpha-v2');
  });

  it('throws if a field on InMemoryState is not a Map instead of skipping it', () => {
    const live = buildLiveState();
    const fresh = buildFreshState();
    (fresh as unknown as Record<string, unknown>).someFutureIndex = new Set(['x']);
    (live as unknown as Record<string, unknown>).someFutureIndex = new Set();

    expect(() => swapInPlace(live, fresh)).toThrow(/someFutureIndex/);
  });
});
