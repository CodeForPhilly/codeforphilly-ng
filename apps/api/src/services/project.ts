/**
 * ProjectService — read operations against in-memory state.
 */
import type { HelpWantedRole, Person, Project, ProjectMembership, Tag } from '@cfp/shared/schemas';
import type { InMemoryState } from '../store/memory/state.js';
import type { FtsEngine } from '../store/fts.js';
import { getProjectFacets, type ProjectFacets } from '../store/memory/facets.js';
import type { CallerSession } from './permissions.js';
import { computeProjectPermissions } from './permissions.js';
import {
  serializeProjectDetail,
  serializeProjectListItem,
  type ProjectDetail,
  type ProjectListItem,
} from './serializers/project.js';

export interface ProjectListOptions {
  readonly q?: string;
  readonly stage?: string;
  readonly stageIn?: string[];
  readonly tag?: string[];
  readonly maintainer?: string;
  readonly memberSlug?: string;
  readonly helpWanted?: boolean;
  readonly featured?: boolean;
  readonly includeDeleted?: boolean;
  readonly sort?: string;
  readonly page?: number;
  readonly perPage?: number;
}

export interface ProjectListResult {
  readonly items: ProjectListItem[];
  readonly totalItems: number;
  readonly facets: ProjectFacets;
}

const ALLOWED_SORT_KEYS = new Set(['createdAt', 'updatedAt', 'title', 'stage']);
const STAGE_ORDER = ['commenting', 'bootstrapping', 'prototyping', 'testing', 'maintaining', 'drifting', 'hibernating'];

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

function compareProjects(a: Project, b: Project, sortSpec: Array<{ key: string; desc: boolean }>): number {
  for (const { key, desc } of sortSpec) {
    let cmp = 0;
    if (key === 'title') {
      cmp = a.title.localeCompare(b.title);
    } else if (key === 'stage') {
      cmp = STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage);
    } else if (key === 'createdAt') {
      cmp = a.createdAt.localeCompare(b.createdAt);
    } else if (key === 'updatedAt') {
      cmp = a.updatedAt.localeCompare(b.updatedAt);
    }
    if (cmp !== 0) return desc ? -cmp : cmp;
  }
  return 0;
}

export class ProjectService {
  readonly #state: InMemoryState;
  readonly #fts: FtsEngine;

  constructor(state: InMemoryState, fts: FtsEngine) {
    this.#state = state;
    this.#fts = fts;
  }

  list(opts: ProjectListOptions): ProjectListResult | { error: 'invalid_sort' | 'invalid_filter' } {
    const sortSpec = parseSortSpec(opts.sort ?? '-updatedAt');
    if (!sortSpec) return { error: 'invalid_sort' };

    // Get the facets from the unfiltered corpus BEFORE applying filters
    const facets = getProjectFacets(this.#state);

    // FTS filter
    let ftsSlugs: Set<string> | null = null;
    if (opts.q) {
      const slugs = this.#fts.searchProjects(opts.q);
      ftsSlugs = new Set(slugs);
    }

    // memberSlug → personId for membership filter
    let memberPersonId: string | undefined;
    if (opts.memberSlug) {
      memberPersonId = this.#state.personIdBySlug.get(opts.memberSlug);
      if (!memberPersonId) {
        return { items: [], totalItems: 0, facets };
      }
    }

    // maintainer slug → id
    let maintainerPersonId: string | undefined;
    if (opts.maintainer) {
      maintainerPersonId = this.#state.personIdBySlug.get(opts.maintainer);
      if (!maintainerPersonId) {
        return { items: [], totalItems: 0, facets };
      }
    }

    // tag handles → tag IDs
    let filterTagIds: Set<string> | undefined;
    if (opts.tag && opts.tag.length > 0) {
      filterTagIds = new Set();
      for (const handle of opts.tag) {
        const tagId = this.#state.tagIdByHandle.get(handle);
        if (tagId) filterTagIds.add(tagId);
      }
    }

    // stageIn
    const stageInSet = opts.stageIn ? new Set(opts.stageIn) : null;

    const filtered = [...this.#state.projects.values()].filter((p) => {
      // Soft-delete filter
      if (p.deletedAt && !opts.includeDeleted) return false;

      // FTS
      if (ftsSlugs && !ftsSlugs.has(p.slug)) return false;

      // Stage filters
      if (opts.stage && p.stage !== opts.stage) return false;
      if (stageInSet && !stageInSet.has(p.stage)) return false;

      // Featured
      if (opts.featured !== undefined && p.featured !== opts.featured) return false;

      // Maintainer
      if (maintainerPersonId && p.maintainerId !== maintainerPersonId) return false;

      // Tag filter (AND semantics)
      if (filterTagIds && filterTagIds.size > 0) {
        const projectAssignments = this.#state.tagAssignmentsByTaggable.get(p.id);
        if (!projectAssignments) return false;
        const projectTagIds = new Set(
          [...projectAssignments]
            .map((taId) => this.#state.tagAssignments.get(taId)?.tagId)
            .filter((id): id is string => id !== undefined),
        );
        for (const tagId of filterTagIds) {
          if (!projectTagIds.has(tagId)) return false;
        }
      }

      // Member filter
      if (memberPersonId) {
        const personMemberships = this.#state.membershipsByPerson.get(memberPersonId);
        if (!personMemberships) return false;
        const isMember = [...personMemberships].some(
          (mId) => this.#state.projectMemberships.get(mId)?.projectId === p.id,
        );
        if (!isMember) return false;
      }

      // Help-wanted filter
      if (opts.helpWanted) {
        const roles = this.#state.helpWantedByProject.get(p.id);
        if (!roles) return false;
        const hasOpen = [...roles].some(
          (rId) => this.#state.helpWantedRoles.get(rId)?.status === 'open',
        );
        if (!hasOpen) return false;
      }

      return true;
    });

    // Sort
    filtered.sort((a, b) => compareProjects(a, b, sortSpec));

    const totalItems = filtered.length;

    // Pagination
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));
    const slice = filtered.slice((page - 1) * perPage, page * perPage);

    const items = slice.map((project) => this.#serializeListItem(project));

    return { items, totalItems, facets };
  }

  get(slug: string, caller?: CallerSession): ProjectDetail | null {
    const projectId = this.#state.projectIdBySlug.get(slug);
    if (!projectId) return null;
    const project = this.#state.projects.get(projectId);
    if (!project) return null;

    const isStaff =
      caller?.accountLevel === 'staff' || caller?.accountLevel === 'administrator';
    if (project.deletedAt && !isStaff) return null;

    const memberships = this.#getMembershipsForProject(project.id);
    const memberPeople = this.#getPeopleForMemberships(memberships);
    const maintainer = project.maintainerId
      ? (this.#state.people.get(project.maintainerId) ?? null)
      : null;

    const openHelpWantedRoles = this.#getOpenHelpWantedRoles(project.id);
    const helpWantedTags = this.#getHelpWantedTags(openHelpWantedRoles.map((r) => r.id));

    const projectTags = this.#getTagsForEntity(project.id, 'project');

    const updateCount = this.#state.updatesByProject.get(project.id)?.size ?? 0;
    const buzzCount = this.#state.buzzByProject.get(project.id)?.size ?? 0;

    const permissions = computeProjectPermissions(caller, project, memberships);

    return serializeProjectDetail(project, {
      maintainer,
      memberships,
      memberPeople,
      openHelpWantedRoles,
      helpWantedTags,
      tags: projectTags,
      updateCount,
      buzzCount,
      permissions,
    });
  }

  #serializeListItem(project: Project): ProjectListItem {
    const memberships = this.#getMembershipsForProject(project.id);
    const memberPeople = this.#getPeopleForMemberships(memberships);
    const maintainer = project.maintainerId
      ? (this.#state.people.get(project.maintainerId) ?? null)
      : null;

    const openHelpWantedCount = [...(this.#state.helpWantedByProject.get(project.id) ?? [])]
      .filter((rId) => this.#state.helpWantedRoles.get(rId)?.status === 'open').length;

    const tagAssignments = [...(this.#state.tagAssignmentsByTaggable.get(project.id) ?? [])]
      .map((taId) => this.#state.tagAssignments.get(taId))
      .filter((ta): ta is NonNullable<typeof ta> => ta !== undefined);

    return serializeProjectListItem(project, {
      maintainer,
      memberships,
      memberPeople,
      openHelpWantedCount,
      tags: [],
      tagAssignments,
      allTags: this.#state.tags,
    });
  }

  #getMembershipsForProject(projectId: string): ProjectMembership[] {
    const mIds = this.#state.membershipsByProject.get(projectId) ?? new Set();
    return [...mIds]
      .map((id) => this.#state.projectMemberships.get(id))
      .filter((m): m is ProjectMembership => m !== undefined);
  }

  #getPeopleForMemberships(memberships: ProjectMembership[]): Map<string, Person> {
    const map = new Map<string, Person>();
    for (const m of memberships) {
      const p = this.#state.people.get(m.personId);
      if (p) map.set(p.id, p);
    }
    return map;
  }

  #getOpenHelpWantedRoles(projectId: string): HelpWantedRole[] {
    const rIds = this.#state.helpWantedByProject.get(projectId) ?? new Set();
    return [...rIds]
      .map((id) => this.#state.helpWantedRoles.get(id))
      .filter((r): r is HelpWantedRole => r !== undefined && r.status === 'open');
  }

  #getHelpWantedTags(roleIds: string[]): Map<string, Tag[]> {
    const map = new Map<string, Tag[]>();
    for (const roleId of roleIds) {
      const taIds = this.#state.tagAssignmentsByTaggable.get(roleId) ?? new Set();
      const tags = [...taIds]
        .map((taId) => this.#state.tagAssignments.get(taId))
        .filter((ta): ta is NonNullable<typeof ta> => ta?.taggableType === 'help_wanted_role')
        .map((ta) => this.#state.tags.get(ta.tagId))
        .filter((t): t is Tag => t !== undefined);
      map.set(roleId, tags);
    }
    return map;
  }

  #getTagsForEntity(entityId: string, type: 'project' | 'person' | 'help_wanted_role'): Tag[] {
    const taIds = this.#state.tagAssignmentsByTaggable.get(entityId) ?? new Set();
    return [...taIds]
      .map((taId) => this.#state.tagAssignments.get(taId))
      .filter((ta): ta is NonNullable<typeof ta> => ta?.taggableType === type)
      .map((ta) => this.#state.tags.get(ta.tagId))
      .filter((t): t is Tag => t !== undefined);
  }
}
