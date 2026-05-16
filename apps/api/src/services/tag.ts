/**
 * TagService — read operations against in-memory state.
 */
import type { Tag, TagAssignment } from '@cfp/shared/schemas';
import type { InMemoryState } from '../store/memory/state.js';
import { serializeTag, type TagResponse } from './serializers/tag.js';

export interface TagListOptions {
  readonly namespace?: string;
  readonly q?: string;
  readonly taggableType?: string;
  readonly sort?: string;
  readonly page?: number;
  readonly perPage?: number;
}

export interface TagListResult {
  readonly items: TagResponse[];
  readonly totalItems: number;
}

const ALLOWED_SORT_KEYS = new Set(['title', 'projectCount', 'personCount']);

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

export class TagService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  list(opts: TagListOptions): TagListResult | { error: 'invalid_sort' | 'invalid_filter' } {
    const sortSpec = parseSortSpec(opts.sort ?? '-projectCount');
    if (!sortSpec) return { error: 'invalid_sort' };

    // Precompute counts for all tags
    const counts = this.#computeTagCounts();

    let tags = [...this.#state.tags.values()];

    if (opts.namespace) {
      const validNamespaces = new Set(['topic', 'tech', 'event']);
      if (!validNamespaces.has(opts.namespace)) return { error: 'invalid_filter' };
      tags = tags.filter((t) => t.namespace === opts.namespace);
    }

    if (opts.q) {
      const q = opts.q.toLowerCase();
      tags = tags.filter(
        (t) => t.slug.includes(q) || t.title.toLowerCase().includes(q),
      );
    }

    if (opts.taggableType) {
      const validTypes = new Set(['project', 'person', 'help_wanted_role']);
      if (!validTypes.has(opts.taggableType)) return { error: 'invalid_filter' };
      tags = tags.filter((t) => {
        const c = counts.get(t.id);
        if (!c) return false;
        if (opts.taggableType === 'project') return c.project > 0;
        if (opts.taggableType === 'person') return c.person > 0;
        if (opts.taggableType === 'help_wanted_role') return c.helpWanted > 0;
        return false;
      });
    }

    // Sort
    tags.sort((a, b) => {
      const ca = counts.get(a.id) ?? { project: 0, person: 0, helpWanted: 0 };
      const cb = counts.get(b.id) ?? { project: 0, person: 0, helpWanted: 0 };
      for (const { key, desc } of sortSpec) {
        let cmp = 0;
        if (key === 'title') cmp = a.title.localeCompare(b.title);
        else if (key === 'projectCount') cmp = ca.project - cb.project;
        else if (key === 'personCount') cmp = ca.person - cb.person;
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });

    const totalItems = tags.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 100));
    const slice = tags.slice((page - 1) * perPage, page * perPage);

    const tagAssignments = [...this.#state.tagAssignments.values()];
    const items = slice.map((tag) => serializeTag(tag, { tagAssignments }));

    return { items, totalItems };
  }

  get(handle: string): TagResponse | null {
    const tagId = this.#state.tagIdByHandle.get(handle);
    if (!tagId) return null;
    const tag = this.#state.tags.get(tagId);
    if (!tag) return null;

    const tagAssignments = [...this.#state.tagAssignments.values()];
    return serializeTag(tag, { tagAssignments });
  }

  #computeTagCounts(): Map<string, { project: number; person: number; helpWanted: number }> {
    const counts = new Map<string, { project: number; person: number; helpWanted: number }>();

    for (const ta of this.#state.tagAssignments.values()) {
      const existing = counts.get(ta.tagId) ?? { project: 0, person: 0, helpWanted: 0 };
      if (ta.taggableType === 'project') existing.project++;
      else if (ta.taggableType === 'person') existing.person++;
      else if (ta.taggableType === 'help_wanted_role') existing.helpWanted++;
      counts.set(ta.tagId, existing);
    }

    return counts;
  }

  getTagsByIds(tagIds: Set<string>): Tag[] {
    return [...tagIds]
      .map((id) => this.#state.tags.get(id))
      .filter((t): t is Tag => t !== undefined);
  }

  getTagAssignmentsForTaggable(taggableId: string): TagAssignment[] {
    const taIds = this.#state.tagAssignmentsByTaggable.get(taggableId) ?? new Set();
    return [...taIds]
      .map((id) => this.#state.tagAssignments.get(id))
      .filter((ta): ta is TagAssignment => ta !== undefined);
  }
}
