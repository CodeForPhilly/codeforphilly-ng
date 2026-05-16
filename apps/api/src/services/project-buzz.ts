/**
 * ProjectBuzzService — read operations.
 */
import type { ProjectBuzz } from '@cfp/shared/schemas';
import type { InMemoryState } from '../store/memory/state.js';
import type { CallerSession } from './permissions.js';
import { computeBuzzPermissions } from './permissions.js';
import {
  serializeProjectBuzz,
  type ProjectBuzzResponse,
} from './serializers/project-buzz.js';

export interface ProjectBuzzListOptions {
  readonly page?: number;
  readonly perPage?: number;
  readonly sort?: string;
}

export interface GlobalBuzzFeedOptions {
  readonly page?: number;
  readonly perPage?: number;
  readonly since?: string;
  readonly tag?: string[];
}

const ALLOWED_SORT_KEYS = new Set(['publishedAt', 'createdAt']);

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

export class ProjectBuzzService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  listForProject(
    projectSlug: string,
    opts: ProjectBuzzListOptions,
    caller?: CallerSession,
  ): { items: ProjectBuzzResponse[]; totalItems: number } | { error: 'not_found' | 'invalid_sort' } {
    const sortSpec = parseSortSpec(opts.sort ?? '-publishedAt');
    if (!sortSpec) return { error: 'invalid_sort' };

    const projectId = this.#state.projectIdBySlug.get(projectSlug);
    if (!projectId) return { error: 'not_found' };
    const project = this.#state.projects.get(projectId);
    if (!project || project.deletedAt) return { error: 'not_found' };

    const buzzIds = this.#state.buzzByProject.get(projectId) ?? new Set();
    const buzzes = [...buzzIds]
      .map((id) => this.#state.projectBuzz.get(id))
      .filter((b): b is ProjectBuzz => b !== undefined);

    buzzes.sort((a, b) => {
      for (const { key, desc } of sortSpec) {
        let cmp = 0;
        if (key === 'publishedAt') cmp = a.publishedAt.localeCompare(b.publishedAt);
        else if (key === 'createdAt') cmp = a.createdAt.localeCompare(b.createdAt);
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });

    const totalItems = buzzes.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 20));
    const slice = buzzes.slice((page - 1) * perPage, page * perPage);

    const items = slice.map((b) => {
      const postedBy = b.postedById ? (this.#state.people.get(b.postedById) ?? null) : null;
      const permissions = computeBuzzPermissions(caller, b);
      return serializeProjectBuzz(b, { project: project!, postedBy, permissions });
    });

    return { items, totalItems };
  }

  globalFeed(
    opts: GlobalBuzzFeedOptions,
    caller?: CallerSession,
  ): { items: ProjectBuzzResponse[]; totalItems: number } {
    let filterProjectIds: Set<string> | undefined;
    if (opts.tag && opts.tag.length > 0) {
      filterProjectIds = new Set();
      for (const handle of opts.tag) {
        const tagId = this.#state.tagIdByHandle.get(handle);
        if (!tagId) continue;
        const taIds = this.#state.tagAssignmentsByTag.get(tagId) ?? new Set();
        for (const taId of taIds) {
          const ta = this.#state.tagAssignments.get(taId);
          if (ta?.taggableType === 'project') filterProjectIds.add(ta.taggableId);
        }
      }
    }

    const buzzes = [...this.#state.projectBuzz.values()].filter((b) => {
      const project = this.#state.projects.get(b.projectId);
      if (!project || project.deletedAt) return false;
      if (opts.since && b.publishedAt < opts.since) return false;
      if (filterProjectIds && !filterProjectIds.has(b.projectId)) return false;
      return true;
    });

    // Sort by publishedAt desc (activity feed sort key per spec)
    buzzes.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

    const totalItems = buzzes.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));
    const slice = buzzes.slice((page - 1) * perPage, page * perPage);

    const items = slice.map((b) => {
      const project = this.#state.projects.get(b.projectId)!;
      const postedBy = b.postedById ? (this.#state.people.get(b.postedById) ?? null) : null;
      const permissions = computeBuzzPermissions(caller, b);
      return serializeProjectBuzz(b, { project, postedBy, permissions });
    });

    return { items, totalItems };
  }
}
