/**
 * PersonService — read operations against in-memory state.
 */
import type { Person, Project, ProjectMembership, ProjectUpdate } from '@cfp/shared/schemas';
import type { InMemoryState } from '../store/memory/state.js';
import type { FtsEngine } from '../store/fts.js';
import { getPeopleFacets, type PeopleFacets } from '../store/memory/facets.js';
import type { CallerSession } from './permissions.js';
import { computePersonPermissions } from './permissions.js';
import {
  serializePersonDetail,
  serializePersonListItem,
  type PersonDetail,
  type PersonListItem,
} from './serializers/person.js';

export interface PersonListOptions {
  readonly q?: string;
  readonly tag?: string[];
  readonly accountLevel?: string;
  readonly sort?: string;
  readonly page?: number;
  readonly perPage?: number;
}

export interface PersonListResult {
  readonly items: PersonListItem[];
  readonly totalItems: number;
  readonly facets: PeopleFacets;
}

const ALLOWED_SORT_KEYS = new Set(['createdAt', 'fullName']);

function parseSortSpec(sort: string | undefined): Array<{ key: string; desc: boolean }> | null {
  if (!sort) return null;
  const parts = sort.split(',').map((s) => s.trim()).filter(Boolean);
  const result: Array<{ key: string; desc: boolean }> = [];
  for (const part of parts) {
    const desc = part.startsWith('-');
    const key = desc ? part.slice(1) : part;
    if (!ALLOWED_SORT_KEYS.has(key)) return null;
    result.push({ key, desc });
  }
  return result;
}

function comparePeople(a: Person, b: Person, sortSpec: Array<{ key: string; desc: boolean }>): number {
  for (const { key, desc } of sortSpec) {
    let cmp = 0;
    if (key === 'fullName') {
      cmp = a.fullName.localeCompare(b.fullName);
    } else if (key === 'createdAt') {
      cmp = a.createdAt.localeCompare(b.createdAt);
    }
    if (cmp !== 0) return desc ? -cmp : cmp;
  }
  return 0;
}

export class PersonService {
  readonly #state: InMemoryState;
  readonly #fts: FtsEngine;

  constructor(state: InMemoryState, fts: FtsEngine) {
    this.#state = state;
    this.#fts = fts;
  }

  list(
    opts: PersonListOptions,
    caller?: CallerSession,
  ): PersonListResult | { error: 'invalid_sort' | 'invalid_filter' } {
    const sortSpec = parseSortSpec(opts.sort ?? '-createdAt');
    if (!sortSpec) return { error: 'invalid_sort' };

    const facets = getPeopleFacets(this.#state);

    const isStaff =
      caller?.accountLevel === 'staff' || caller?.accountLevel === 'administrator';

    // accountLevel filter is staff-only
    if (opts.accountLevel && !isStaff) {
      return { items: [], totalItems: 0, facets };
    }

    let ftsSlugs: Set<string> | null = null;
    if (opts.q) {
      const slugs = this.#fts.searchPeople(opts.q);
      ftsSlugs = new Set(slugs);
    }

    let filterTagIds: Set<string> | undefined;
    if (opts.tag && opts.tag.length > 0) {
      filterTagIds = new Set();
      for (const handle of opts.tag) {
        const tagId = this.#state.tagIdByHandle.get(handle);
        if (tagId) filterTagIds.add(tagId);
      }
    }

    const filtered = [...this.#state.people.values()].filter((p) => {
      if (p.deletedAt && !isStaff) return false;

      if (ftsSlugs && !ftsSlugs.has(p.slug)) return false;

      if (opts.accountLevel && p.accountLevel !== opts.accountLevel) return false;

      if (filterTagIds && filterTagIds.size > 0) {
        const personAssignments = this.#state.tagAssignmentsByTaggable.get(p.id);
        if (!personAssignments) return false;
        const personTagIds = new Set(
          [...personAssignments]
            .map((taId) => this.#state.tagAssignments.get(taId)?.tagId)
            .filter((id): id is string => id !== undefined),
        );
        for (const tagId of filterTagIds) {
          if (!personTagIds.has(tagId)) return false;
        }
      }

      return true;
    });

    filtered.sort((a, b) => comparePeople(a, b, sortSpec));

    const totalItems = filtered.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));
    const slice = filtered.slice((page - 1) * perPage, page * perPage);

    const items = slice.map((person) => this.#serializeListItem(person));

    return { items, totalItems, facets };
  }

  get(slug: string, caller?: CallerSession): PersonDetail | null {
    const personId = this.#state.personIdBySlug.get(slug);
    if (!personId) return null;
    const person = this.#state.people.get(personId);
    if (!person) return null;

    const isStaff =
      caller?.accountLevel === 'staff' || caller?.accountLevel === 'administrator';
    if (person.deletedAt && !isStaff) return null;

    const memberships = this.#getMembershipsForPerson(person.id);
    const projectsMap = this.#getProjectsForMemberships(memberships);

    const recentUpdates = this.#getRecentUpdates(person.id);
    const updatesProjectsMap = this.#getProjectsForUpdates(recentUpdates);

    const tagAssignments = [...(this.#state.tagAssignmentsByTaggable.get(person.id) ?? [])]
      .map((taId) => this.#state.tagAssignments.get(taId))
      .filter((ta): ta is NonNullable<typeof ta> => ta !== undefined);

    const permissions = computePersonPermissions(caller, person);

    return serializePersonDetail(person, {
      memberships,
      projectsMap,
      recentUpdates,
      updatesProjectsMap,
      tagAssignments,
      allTags: this.#state.tags,
      permissions,
      callerAccountLevel: caller?.accountLevel,
      callerPersonId: caller?.id,
    });
  }

  #serializeListItem(person: Person): PersonListItem {
    const memberOfCount = this.#state.membershipsByPerson.get(person.id)?.size ?? 0;

    const tagAssignments = [...(this.#state.tagAssignmentsByTaggable.get(person.id) ?? [])]
      .map((taId) => this.#state.tagAssignments.get(taId))
      .filter((ta): ta is NonNullable<typeof ta> => ta !== undefined);

    return serializePersonListItem(person, {
      memberOfCount,
      tagAssignments,
      allTags: this.#state.tags,
    });
  }

  #getMembershipsForPerson(personId: string): ProjectMembership[] {
    const mIds = this.#state.membershipsByPerson.get(personId) ?? new Set();
    return [...mIds]
      .map((id) => this.#state.projectMemberships.get(id))
      .filter((m): m is ProjectMembership => m !== undefined);
  }

  #getProjectsForMemberships(memberships: ProjectMembership[]): Map<string, Project> {
    const map = new Map<string, Project>();
    for (const m of memberships) {
      const p = this.#state.projects.get(m.projectId);
      if (p && !p.deletedAt) map.set(p.id, p);
    }
    return map;
  }

  #getRecentUpdates(personId: string): ProjectUpdate[] {
    return [...this.#state.projectUpdates.values()]
      .filter((u) => u.authorId === personId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5);
  }

  #getProjectsForUpdates(updates: ProjectUpdate[]): Map<string, Project> {
    const map = new Map<string, Project>();
    for (const u of updates) {
      const p = this.#state.projects.get(u.projectId);
      if (p) map.set(p.id, p);
    }
    return map;
  }
}
