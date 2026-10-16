/**
 * Hot-reload helper for the in-memory state + FTS index.
 *
 * Builds a fresh `InMemoryState` from the public store, then atomically
 * swaps the contents of the live state object that the services hold
 * references to. The FTS index is reloaded in a single SQLite
 * transaction. The module-level facet cache is invalidated.
 *
 * Failure semantics:
 *   - If `loadInMemoryState` throws (corrupt data, missing sheets, …),
 *     the live state is untouched. The caller surfaces the error.
 *   - If the FTS reload throws after the in-memory swap has started,
 *     the in-memory Maps are already half-mutated. There's no clean
 *     rollback — the caller logs loudly and the operator should
 *     restart the pod. This is acceptable: FTS reload is a single
 *     transaction over SQLite tables we control end-to-end; the
 *     remaining failure modes are catastrophic (out of memory,
 *     SQLite handle gone) and warrant a restart anyway.
 *
 * Used by `apps/api/src/routes/internal.ts` (the `POST
 * /api/_internal/reload-data` webhook).
 */
import type { FastifyInstance } from 'fastify';
import type { Repository } from 'gitsheets';
import { invalidateFacets } from './facets.js';
import { applyChanges, collectChanges } from './incremental.js';
import { loadInMemoryState } from './loader.js';
import type { InMemoryState } from './state.js';

export interface ReloadOptions {
  /**
   * The commit the live state currently reflects. When given, the reload
   * applies only the records that changed since, unless a sheet config
   * changed or the diff is too large.
   */
  readonly fromCommit?: string;
}

export type ReloadMode = 'incremental' | 'full';

/** Whether `.gitsheets/` (the sheet configs) differs between two commits. */
async function sheetConfigsChanged(repo: Repository, from: string, to: string): Promise<boolean> {
  // Direct entries carry each blob's and subtree's hash, so equal listings
  // mean equal `.gitsheets/` trees (contracts/ included).
  const listing = async (commit: string): Promise<string> =>
    JSON.stringify(await repo.listTree(commit, '.gitsheets'));
  const [a, b] = await Promise.all([listing(from), listing(to)]);
  return a !== b;
}

/**
 * Replace the contents of `target`'s Maps with `source`'s Maps. The
 * `target` object identity is preserved so services that captured a
 * reference at boot continue to read the new data through the same
 * pointer.
 *
 * Implemented as `clear()` + `set()` rather than property assignment
 * because the `InMemoryState` interface treats every field as
 * `readonly`-ish: services destructure `.projects`, `.people`, etc., at
 * call time, so the source-of-truth Maps must keep the same identity.
 */
function replaceMapContents<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [k, v] of source) target.set(k, v);
}

/**
 * Bring the live in-memory state, revocation set and FTS index up to the
 * public store's current snapshot, and invalidate the facet cache.
 *
 * With `fromCommit`, applies only the records that changed since (see
 * `incremental.ts`); otherwise, or when configs changed or the diff is
 * large, rebuilds everything. Returns which path ran.
 *
 * The caller must already have refreshed the public store to the new HEAD
 * (`fastify.reconcileDataRepo` does, under the repository write lock).
 */
export async function reloadInMemoryStateAndFts(
  fastify: FastifyInstance,
  opts: ReloadOptions = {},
): Promise<ReloadMode> {
  const { fromCommit } = opts;
  if (fromCommit) {
    if (!(await sheetConfigsChanged(fastify.publicRepo, fromCommit, 'HEAD'))) {
      const changes = await collectChanges(fastify.store.public, fromCommit);
      if (changes) {
        applyChanges(fastify.inMemoryState, fastify.fts, changes);
        await fastify.revocations.loadFromSheet(fastify.store.public);
        invalidateFacets();
        return 'incremental';
      }
    }
  }

  // Step 1: build the fresh in-memory state. If this throws (validator
  // failure on a new record, etc.), the live state is untouched and the
  // caller surfaces the error.
  const fresh = await loadInMemoryState(fastify.store.public);

  // Step 2: mutate the live state in place. Each entry below replaces
  // one Map in the live state object. This block must not `await` —
  // services reading the state during this window would see a partially
  // updated snapshot.
  swapInPlace(fastify.inMemoryState, fresh);

  // Step 3: revocations live outside InMemoryState; reload them from the
  // same snapshot so a revocation pushed upstream takes effect.
  await fastify.revocations.loadFromSheet(fastify.store.public);

  // Step 4: reload the FTS index. If this throws, the in-memory Maps
  // already match `fresh`, but the FTS index will be in an inconsistent
  // state. The route handler logs loudly and returns 5xx.
  fastify.fts.reload(fresh);

  // Step 5: drop the cached facet roll-ups so the next request recomputes.
  invalidateFacets();
  return 'full';
}

/**
 * Synchronously replace the contents of every collection on `live` with
 * the contents from `fresh`. Object identity of `live` — and of every Map
 * hanging off it — is preserved.
 *
 * Enumerates `fresh`'s own properties rather than naming each field: a
 * hand-maintained list silently skipped three secondary indices
 * (`projectIdByLegacyId`, `buzzIdBySlug`, `slugHistory`) and left legacy
 * and slug-history redirects pointing at ids that no longer existed after
 * a re-import + hot reload. Every own property of `InMemoryState` is a Map
 * today; if a future field is anything else this throws so the author has
 * to decide how it's swapped, instead of it being skipped again. Per
 * specs/behaviors/storage.md#hot-reload → Atomicity.
 *
 * Exported for testability — production code should call
 * `reloadInMemoryStateAndFts`.
 */
export function swapInPlace(live: InMemoryState, fresh: InMemoryState): void {
  for (const key of Object.keys(fresh) as (keyof InMemoryState)[]) {
    const target: unknown = live[key];
    const source: unknown = fresh[key];
    if (!(target instanceof Map) || !(source instanceof Map)) {
      throw new Error(
        `swapInPlace: InMemoryState.${key} is not a Map — extend swapInPlace to handle it`,
      );
    }
    replaceMapContents(target, source);
  }
}
