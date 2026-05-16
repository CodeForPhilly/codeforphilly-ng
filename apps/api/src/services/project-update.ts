/**
 * ProjectUpdateService — read operations.
 */
import type { ProjectUpdate } from '@cfp/shared/schemas';
import type { InMemoryState } from '../store/memory/state.js';
import type { CallerSession } from './permissions.js';
import { computeUpdatePermissions } from './permissions.js';
import {
  serializeProjectUpdate,
  type ProjectUpdateResponse,
} from './serializers/project-update.js';

export interface ProjectUpdateListOptions {
  readonly page?: number;
  readonly perPage?: number;
  readonly sort?: string;
}

export interface GlobalUpdateFeedOptions {
  readonly page?: number;
  readonly perPage?: number;
  readonly since?: string;
  readonly tag?: string[];
}

const ALLOWED_SORT_KEYS = new Set(['createdAt', 'number']);

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

export class ProjectUpdateService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  listForProject(
    projectSlug: string,
    opts: ProjectUpdateListOptions,
    caller?: CallerSession,
  ): { items: ProjectUpdateResponse[]; totalItems: number } | { error: 'not_found' | 'invalid_sort' } {
    const sortSpec = parseSortSpec(opts.sort ?? '-createdAt');
    if (!sortSpec) return { error: 'invalid_sort' };

    const projectId = this.#state.projectIdBySlug.get(projectSlug);
    if (!projectId) return { error: 'not_found' };
    const project = this.#state.projects.get(projectId);
    if (!project || project.deletedAt) return { error: 'not_found' };

    const updateIds = this.#state.updatesByProject.get(projectId) ?? new Set();
    const updates = [...updateIds]
      .map((id) => this.#state.projectUpdates.get(id))
      .filter((u): u is ProjectUpdate => u !== undefined);

    updates.sort((a, b) => {
      for (const { key, desc } of sortSpec) {
        let cmp = 0;
        if (key === 'createdAt') cmp = a.createdAt.localeCompare(b.createdAt);
        else if (key === 'number') cmp = a.number - b.number;
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });

    const totalItems = updates.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 20));
    const slice = updates.slice((page - 1) * perPage, page * perPage);

    const items = slice.map((u) => {
      const author = u.authorId ? (this.#state.people.get(u.authorId) ?? null) : null;
      const permissions = computeUpdatePermissions(caller, u);
      return serializeProjectUpdate(u, { project: project!, author, permissions });
    });

    return { items, totalItems };
  }

  getForProject(
    projectSlug: string,
    number: number,
    caller?: CallerSession,
  ): ProjectUpdateResponse | null | { error: 'not_found' } {
    const projectId = this.#state.projectIdBySlug.get(projectSlug);
    if (!projectId) return { error: 'not_found' };
    const project = this.#state.projects.get(projectId);
    if (!project || project.deletedAt) return { error: 'not_found' };

    const updateId = this.#state.updateByProjectAndNumber.get(`${projectId}:${number}`);
    if (!updateId) return null;
    const update = this.#state.projectUpdates.get(updateId);
    if (!update) return null;

    const author = update.authorId ? (this.#state.people.get(update.authorId) ?? null) : null;
    const permissions = computeUpdatePermissions(caller, update);
    return serializeProjectUpdate(update, { project, author, permissions });
  }

  globalFeed(
    opts: GlobalUpdateFeedOptions,
    caller?: CallerSession,
  ): { items: ProjectUpdateResponse[]; totalItems: number } {
    // Optionally filter tag handles to project IDs
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

    const updates = [...this.#state.projectUpdates.values()].filter((u) => {
      const project = this.#state.projects.get(u.projectId);
      if (!project || project.deletedAt) return false;
      if (opts.since && u.createdAt < opts.since) return false;
      if (filterProjectIds && !filterProjectIds.has(u.projectId)) return false;
      return true;
    });

    updates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const totalItems = updates.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));
    const slice = updates.slice((page - 1) * perPage, page * perPage);

    const items = slice.map((u) => {
      const project = this.#state.projects.get(u.projectId)!;
      const author = u.authorId ? (this.#state.people.get(u.authorId) ?? null) : null;
      const permissions = computeUpdatePermissions(caller, u);
      return serializeProjectUpdate(u, { project, author, permissions });
    });

    return { items, totalItems };
  }
}
