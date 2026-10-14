/**
 * Incremental hot reload — specs/behaviors/storage.md → "Hot reload".
 *
 * Instead of re-reading every sheet, diff each in-memory sheet between the
 * commit the live state reflects and the new HEAD (gitsheets
 * `Sheet.diffFrom`), then unindex each changed record's old version and
 * index its new one. `unindex*` is the exact inverse of `index*`, so the
 * result equals a full load of the new tree.
 */
import { RECORD_PATH_KEY, RECORD_SHEET_KEY, type DiffChange } from 'gitsheets';

import type { FtsEngine } from '../fts.js';
import type { PublicStore } from '../public.js';
import {
  indexBlogPost,
  indexEvent,
  indexEventRsvp,
  indexHelpWantedInterest,
  indexHelpWantedRole,
  indexMembership,
  indexPerson,
  indexPersonEvaluation,
  indexProject,
  indexProjectBuzz,
  indexProjectUpdate,
  indexSlugHistory,
  indexTag,
  indexTagAssignment,
  unindexBlogPost,
  unindexEvent,
  unindexEventRsvp,
  unindexHelpWantedInterest,
  unindexHelpWantedRole,
  unindexMembership,
  unindexPerson,
  unindexPersonEvaluation,
  unindexProject,
  unindexProjectBuzz,
  unindexProjectUpdate,
  unindexSlugHistory,
  unindexTag,
  unindexTagAssignment,
  type InMemoryState,
} from './state.js';

/** More changed records than this and a full rebuild is cheaper and safer. */
export const INCREMENTAL_RECORD_LIMIT = 5_000;

type Sheets = PublicStore;
type RecordOf<K extends keyof Sheets> = Sheets[K] extends { queryAll(): Promise<(infer T)[]> }
  ? T
  : never;

interface SheetHandler<K extends keyof Sheets> {
  readonly sheet: K;
  readonly unindex: (state: InMemoryState, record: RecordOf<K>) => void;
  readonly index: (state: InMemoryState, record: RecordOf<K>) => void;
  readonly ftsRemove?: (fts: FtsEngine, record: RecordOf<K>) => void;
  readonly ftsAdd?: (fts: FtsEngine, record: RecordOf<K>) => void;
}

function handler<K extends keyof Sheets>(h: SheetHandler<K>): SheetHandler<K> {
  return h;
}

/** Every sheet the loader reads into InMemoryState, in loader order. */
const HANDLERS = [
  handler({
    sheet: 'projects',
    unindex: unindexProject,
    index: indexProject,
    ftsRemove: (fts, p) => fts.removeProject(p.slug),
    ftsAdd: (fts, p) => {
      if (!p.deletedAt) fts.upsertProject(p.slug, p.title, p.summary ?? '', p.overview ?? '');
    },
  }),
  handler({
    sheet: 'people',
    unindex: unindexPerson,
    index: indexPerson,
    ftsRemove: (fts, p) => fts.removePerson(p.slug),
    ftsAdd: (fts, p) => {
      if (!p.deletedAt) fts.upsertPerson(p.slug, p.fullName, p.bio ?? '');
    },
  }),
  handler({ sheet: 'tags', unindex: unindexTag, index: indexTag }),
  handler({ sheet: 'tag-assignments', unindex: unindexTagAssignment, index: indexTagAssignment }),
  handler({ sheet: 'project-memberships', unindex: unindexMembership, index: indexMembership }),
  handler({ sheet: 'project-updates', unindex: unindexProjectUpdate, index: indexProjectUpdate }),
  handler({ sheet: 'project-buzz', unindex: unindexProjectBuzz, index: indexProjectBuzz }),
  handler({ sheet: 'blog-posts', unindex: unindexBlogPost, index: indexBlogPost }),
  handler({
    sheet: 'help-wanted-roles',
    unindex: unindexHelpWantedRole,
    index: indexHelpWantedRole,
    ftsRemove: (fts, r) => fts.removeHelpWanted(r.id),
    ftsAdd: (fts, r) => fts.upsertHelpWanted(r.id, r.title, r.description),
  }),
  handler({
    sheet: 'help-wanted-interest',
    unindex: unindexHelpWantedInterest,
    index: indexHelpWantedInterest,
  }),
  handler({
    sheet: 'slug-history',
    unindex: unindexSlugHistory,
    index: (state, r) => indexSlugHistory(state, r),
  }),
  handler({
    sheet: 'person-evaluations',
    unindex: unindexPersonEvaluation,
    index: indexPersonEvaluation,
  }),
  handler({ sheet: 'events', unindex: unindexEvent, index: indexEvent }),
  handler({ sheet: 'event-rsvps', unindex: unindexEventRsvp, index: indexEventRsvp }),
] as const;

interface CollectedChanges {
  readonly handler: SheetHandler<keyof Sheets>;
  readonly changes: readonly DiffChange[];
}

/**
 * Collect every changed record between `fromCommit` and each sheet's current
 * read snapshot. Returns null when more than {@link INCREMENTAL_RECORD_LIMIT}
 * records changed, meaning the caller should do a full rebuild.
 */
export async function collectChanges(
  store: PublicStore,
  fromCommit: string,
): Promise<CollectedChanges[] | null> {
  const collected: CollectedChanges[] = [];
  let total = 0;
  for (const h of HANDLERS) {
    const changes: DiffChange[] = [];
    for await (const change of store[h.sheet].diffFrom(fromCommit, { records: true })) {
      changes.push(change);
      if (++total > INCREMENTAL_RECORD_LIMIT) return null;
    }
    if (changes.length > 0) {
      collected.push({ handler: h as unknown as SheetHandler<keyof Sheets>, changes });
    }
  }
  return collected;
}

/**
 * Apply collected changes to the live state and FTS index. Synchronous, so
 * no request handler observes a half-applied diff.
 */
export function applyChanges(
  state: InMemoryState,
  fts: FtsEngine,
  collected: readonly CollectedChanges[],
): number {
  let applied = 0;
  for (const { handler: h, changes } of collected) {
    for (const change of changes) {
      const src = change.src as RecordOf<keyof Sheets> | undefined;
      const dst = change.dst as RecordOf<keyof Sheets> | undefined;
      if (src) {
        h.unindex(state, src);
        h.ftsRemove?.(fts, src);
      }
      if (dst) {
        // Annotate like `queryAll()` does: gitsheets locates a record's
        // current path through these on a later upsert/delete.
        Object.assign(dst, { [RECORD_SHEET_KEY]: h.sheet, [RECORD_PATH_KEY]: change.path });
        h.index(state, dst);
        h.ftsAdd?.(fts, dst);
      }
      applied++;
    }
  }
  return applied;
}
