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
import { invalidateFacets } from './facets.js';
import { loadInMemoryState } from './loader.js';
import type { InMemoryState } from './state.js';
import { openPublicStore } from '../public.js';
import { wireSheetIndices } from '../sheet-indices.js';

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
 * Build a fresh `InMemoryState` from the public store and swap it into
 * the running Fastify instance. The FTS index is reloaded from the same
 * fresh state, and the facet cache is invalidated.
 */
export async function reloadInMemoryStateAndFts(
  fastify: FastifyInstance,
): Promise<void> {
  // Step 1: re-open the public store. Gitsheets caches a `dataTree`
  // snapshot per Sheet at openStore time, so the existing
  // `fastify.store.public` is bound to the pre-fast-forward commit's
  // tree and would queryAll the OLD records. Open against the new HEAD.
  const repoPath = fastify.config.CFP_DATA_REPO_PATH;
  const { store: freshPublic } = await openPublicStore(repoPath);
  await wireSheetIndices(freshPublic);

  // Step 2: build the fresh in-memory state from the new store. If this
  // throws (validator failure on a new record, etc.), the live state is
  // untouched and the caller surfaces the error.
  const fresh = await loadInMemoryState(freshPublic);

  // Step 3: mutate the live state in place. Each entry below replaces
  // one Map in the live state object. This block must not `await` —
  // services reading the state during this window would see a partially
  // updated snapshot.
  swapInPlace(fastify.inMemoryState, fresh);

  // Step 4: swap the public-store reference so direct readers
  // (revocation sweeper, etc.) see the new dataTree. The repository
  // handle stays the same; only the Sheet snapshots are replaced.
  fastify.store.swapPublic(freshPublic);

  // Step 5: reload the FTS index. If this throws, the in-memory Maps
  // already match `fresh`, but the FTS index will be in an inconsistent
  // state. The route handler logs loudly and returns 5xx.
  fastify.fts.reload(fresh);

  // Step 6: drop the cached facet roll-ups so the next request recomputes.
  invalidateFacets();
}

/**
 * Synchronously replace the contents of every Map on `live` with the
 * contents from `fresh`. Object identity of `live` is preserved.
 *
 * Exported for testability — production code should call
 * `reloadInMemoryStateAndFts`.
 */
export function swapInPlace(live: InMemoryState, fresh: InMemoryState): void {
  // Primary entity maps.
  replaceMapContents(live.projects, fresh.projects);
  replaceMapContents(live.people, fresh.people);
  replaceMapContents(live.tags, fresh.tags);
  replaceMapContents(live.tagAssignments, fresh.tagAssignments);
  replaceMapContents(live.projectMemberships, fresh.projectMemberships);
  replaceMapContents(live.projectUpdates, fresh.projectUpdates);
  replaceMapContents(live.projectBuzz, fresh.projectBuzz);
  replaceMapContents(live.blogPosts, fresh.blogPosts);
  replaceMapContents(live.helpWantedRoles, fresh.helpWantedRoles);
  replaceMapContents(live.helpWantedInterest, fresh.helpWantedInterest);

  // Secondary indices.
  replaceMapContents(live.projectSlugById, fresh.projectSlugById);
  replaceMapContents(live.projectIdBySlug, fresh.projectIdBySlug);
  replaceMapContents(live.personSlugById, fresh.personSlugById);
  replaceMapContents(live.personIdBySlug, fresh.personIdBySlug);
  replaceMapContents(live.tagIdByHandle, fresh.tagIdByHandle);
  replaceMapContents(live.membershipsByProject, fresh.membershipsByProject);
  replaceMapContents(live.membershipsByPerson, fresh.membershipsByPerson);
  replaceMapContents(live.updatesByProject, fresh.updatesByProject);
  replaceMapContents(live.updateByProjectAndNumber, fresh.updateByProjectAndNumber);
  replaceMapContents(live.buzzByProject, fresh.buzzByProject);
  replaceMapContents(live.buzzByProjectAndSlug, fresh.buzzByProjectAndSlug);
  replaceMapContents(live.blogPostIdBySlug, fresh.blogPostIdBySlug);
  replaceMapContents(live.blogPostIdByLegacyId, fresh.blogPostIdByLegacyId);
  replaceMapContents(live.helpWantedByProject, fresh.helpWantedByProject);
  replaceMapContents(live.tagAssignmentsByTaggable, fresh.tagAssignmentsByTaggable);
  replaceMapContents(live.tagAssignmentsByTag, fresh.tagAssignmentsByTag);
  replaceMapContents(live.interestByRoleAndPerson, fresh.interestByRoleAndPerson);
  replaceMapContents(live.interestByRole, fresh.interestByRole);
}
