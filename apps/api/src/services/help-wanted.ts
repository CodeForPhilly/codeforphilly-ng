/**
 * HelpWantedService — read operations.
 */
import type { HelpWantedRole, Project, ProjectMembership } from '@cfp/shared/schemas';
import type { InMemoryState } from '../store/memory/state.js';
import type { FtsEngine } from '../store/fts.js';
import type { CallerSession } from './permissions.js';
import { computeHelpWantedPermissions } from './permissions.js';
import {
  serializeHelpWantedRole,
  type HelpWantedRoleResponse,
} from './serializers/help-wanted.js';

export interface ProjectHelpWantedListOptions {
  readonly status?: string;
  readonly page?: number;
  readonly perPage?: number;
  readonly sort?: string;
}

export interface GlobalHelpWantedOptions {
  readonly status?: string;
  readonly tag?: string[];
  readonly commitmentMax?: number;
  readonly q?: string;
  readonly sort?: string;
  readonly page?: number;
  readonly perPage?: number;
}

const PROJECT_HELP_ALLOWED_SORT = new Set(['createdAt', 'commitmentHoursPerWeek']);
const GLOBAL_HELP_ALLOWED_SORT = new Set(['createdAt', 'commitmentHoursPerWeek']);

function parseSortSpec(
  sort: string | undefined,
  allowed: Set<string>,
): Array<{ key: string; desc: boolean }> | null {
  if (!sort) return null;
  const parts = sort.split(',').map((s) => s.trim()).filter(Boolean);
  const result: Array<{ key: string; desc: boolean }> = [];
  for (const part of parts) {
    const desc = part.startsWith('-');
    const key = desc ? part.slice(1) : part;
    if (!allowed.has(key)) return null;
    result.push({ key, desc });
  }
  return result;
}

export class HelpWantedService {
  readonly #state: InMemoryState;
  readonly #fts: FtsEngine;

  constructor(state: InMemoryState, fts: FtsEngine) {
    this.#state = state;
    this.#fts = fts;
  }

  listForProject(
    projectSlug: string,
    opts: ProjectHelpWantedListOptions,
    caller?: CallerSession,
  ): { items: HelpWantedRoleResponse[]; totalItems: number } | { error: 'not_found' | 'invalid_sort' | 'invalid_filter' } {
    const sortSpec = parseSortSpec(opts.sort ?? '-createdAt', PROJECT_HELP_ALLOWED_SORT);
    if (!sortSpec) return { error: 'invalid_sort' };

    const projectId = this.#state.projectIdBySlug.get(projectSlug);
    if (!projectId) return { error: 'not_found' };
    const project = this.#state.projects.get(projectId);
    if (!project || project.deletedAt) return { error: 'not_found' };

    const validStatuses = new Set(['open', 'filled', 'closed']);
    if (opts.status && !validStatuses.has(opts.status)) return { error: 'invalid_filter' };

    const roleIds = this.#state.helpWantedByProject.get(projectId) ?? new Set();
    let roles = [...roleIds]
      .map((id) => this.#state.helpWantedRoles.get(id))
      .filter((r): r is HelpWantedRole => r !== undefined);

    if (opts.status) {
      roles = roles.filter((r) => r.status === opts.status);
    }

    roles.sort((a, b) => {
      for (const { key, desc } of sortSpec) {
        let cmp = 0;
        if (key === 'createdAt') cmp = a.createdAt.localeCompare(b.createdAt);
        else if (key === 'commitmentHoursPerWeek') {
          cmp = (a.commitmentHoursPerWeek ?? 0) - (b.commitmentHoursPerWeek ?? 0);
        }
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });

    const totalItems = roles.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 20));
    const slice = roles.slice((page - 1) * perPage, page * perPage);

    const memberships = this.#getMemberships(projectId);
    const items = slice.map((role) => this.#serializeRole(role, project, memberships, caller));

    return { items, totalItems };
  }

  globalBrowse(
    opts: GlobalHelpWantedOptions,
    caller?: CallerSession,
  ): { items: HelpWantedRoleResponse[]; totalItems: number; facets: { byTech: Array<{ tag: string; count: number }>; byTopic: Array<{ tag: string; count: number }> } } | { error: 'invalid_sort' | 'invalid_filter' } {
    const sortSpec = parseSortSpec(opts.sort ?? '-createdAt', GLOBAL_HELP_ALLOWED_SORT);
    if (!sortSpec) return { error: 'invalid_sort' };

    const validStatuses = new Set(['open', 'filled', 'closed']);
    const statusFilter = opts.status ?? 'open';
    if (!validStatuses.has(statusFilter)) return { error: 'invalid_filter' };

    // FTS
    let ftsIds: Set<string> | null = null;
    if (opts.q) {
      const ids = this.#fts.searchHelpWanted(opts.q);
      ftsIds = new Set(ids);
    }

    // Tag filter on role tags
    let filterTagIds: Set<string> | undefined;
    if (opts.tag && opts.tag.length > 0) {
      filterTagIds = new Set();
      for (const handle of opts.tag) {
        const tagId = this.#state.tagIdByHandle.get(handle);
        if (tagId) filterTagIds.add(tagId);
      }
    }

    const roles = [...this.#state.helpWantedRoles.values()].filter((r) => {
      const project = this.#state.projects.get(r.projectId);
      if (!project || project.deletedAt) return false;

      if (r.status !== statusFilter) return false;

      if (ftsIds && !ftsIds.has(r.id)) return false;

      if (opts.commitmentMax !== undefined) {
        const h = r.commitmentHoursPerWeek ?? 0;
        if (h > opts.commitmentMax) return false;
      }

      if (filterTagIds && filterTagIds.size > 0) {
        const roleAssignments = this.#state.tagAssignmentsByTaggable.get(r.id);
        if (!roleAssignments) return false;
        const roleTagIds = new Set(
          [...roleAssignments]
            .map((taId) => this.#state.tagAssignments.get(taId)?.tagId)
            .filter((id): id is string => id !== undefined),
        );
        for (const tagId of filterTagIds) {
          if (!roleTagIds.has(tagId)) return false;
        }
      }

      return true;
    });

    // Compute facets over filtered set (role tags, by namespace)
    const facets = this.#computeFacets(roles);

    roles.sort((a, b) => {
      for (const { key, desc } of sortSpec) {
        let cmp = 0;
        if (key === 'createdAt') cmp = a.createdAt.localeCompare(b.createdAt);
        else if (key === 'commitmentHoursPerWeek') {
          cmp = (a.commitmentHoursPerWeek ?? 0) - (b.commitmentHoursPerWeek ?? 0);
        }
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });

    const totalItems = roles.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));
    const slice = roles.slice((page - 1) * perPage, page * perPage);

    const items = slice.map((role) => {
      const project = this.#state.projects.get(role.projectId)!;
      const memberships = this.#getMemberships(role.projectId);
      return this.#serializeRole(role, project, memberships, caller);
    });

    return { items, totalItems, facets };
  }

  #serializeRole(
    role: HelpWantedRole,
    project: Project,
    memberships: ProjectMembership[],
    caller?: CallerSession,
  ): HelpWantedRoleResponse {
    const postedBy = this.#state.people.get(role.postedById) ?? null;
    const filledBy = role.filledById ? (this.#state.people.get(role.filledById) ?? null) : null;

    const interestCount = this.#state.interestByRole.get(role.id)?.size ?? 0;

    const alreadyExpressedInterest = caller
      ? this.#state.interestByRoleAndPerson.has(`${role.id}:${caller.id}`)
      : false;

    const tagAssignments = [...(this.#state.tagAssignmentsByTaggable.get(role.id) ?? [])]
      .map((taId) => this.#state.tagAssignments.get(taId))
      .filter((ta): ta is NonNullable<typeof ta> => ta !== undefined);

    const permissions = computeHelpWantedPermissions(
      caller,
      role,
      project,
      memberships,
      alreadyExpressedInterest,
    );

    return serializeHelpWantedRole(role, {
      project,
      postedBy,
      filledBy,
      tagAssignments,
      allTags: this.#state.tags,
      interestCount,
      permissions,
    });
  }

  #getMemberships(projectId: string) {
    const mIds = this.#state.membershipsByProject.get(projectId) ?? new Set();
    return [...mIds]
      .map((id) => this.#state.projectMemberships.get(id))
      .filter((m): m is NonNullable<typeof m> => m !== undefined);
  }

  #computeFacets(roles: HelpWantedRole[]): {
    byTech: Array<{ tag: string; count: number }>;
    byTopic: Array<{ tag: string; count: number }>;
  } {
    const techCounts = new Map<string, number>();
    const topicCounts = new Map<string, number>();

    for (const role of roles) {
      const taIds = this.#state.tagAssignmentsByTaggable.get(role.id) ?? new Set();
      for (const taId of taIds) {
        const ta = this.#state.tagAssignments.get(taId);
        if (!ta || ta.taggableType !== 'help_wanted_role') continue;
        const tag = this.#state.tags.get(ta.tagId);
        if (!tag) continue;
        const handle = `${tag.namespace}.${tag.slug}`;
        if (tag.namespace === 'tech') techCounts.set(handle, (techCounts.get(handle) ?? 0) + 1);
        else if (tag.namespace === 'topic') topicCounts.set(handle, (topicCounts.get(handle) ?? 0) + 1);
      }
    }

    const toArr = (m: Map<string, number>) =>
      [...m.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    return { byTech: toArr(techCounts), byTopic: toArr(topicCounts) };
  }
}
