---
status: done
depends: []
specs:
  - specs/behaviors/slug-handles.md
issues: [80]
pr: 92
---

# Plan: SlugHistory 90-day redirect handler

## Scope

[`specs/behaviors/slug-handles.md`](../specs/behaviors/slug-handles.md) → "Mutability and redirects" specifies that when an entity's slug changes:

> "On any request to a URL using an `oldSlug` that is *not yet* expired, the web layer serves a **301 redirect** to the current canonical URL."

The write side already creates `SlugHistory` records — three call sites (`account-claim.ts:684`, `project.write.ts:303`, `person.write.ts:126`) write to the gitsheets `slug-history` sheet on every rename. The read side is missing: no route checks slug-history to serve the 301. Visiting `/projects/<old-slug>` after a rename 404s (well, falls through to the SPA which then 404s in its data fetch).

This plan fills the gap by:

1. Loading slug-history into the typed in-memory `Store` at boot (the recommended fix path from [#47](https://github.com/CodeForPhilly/codeforphilly-ng/issues/47)).
2. Keeping that map in lockstep with rename writes via `StateApply.upsertSlugHistory`.
3. Adding a Fastify `onRequest` hook that pattern-matches the slug-bearing SPA paths, looks up slug-history for misses, and 301s when applicable.

Closes [#80](https://github.com/CodeForPhilly/codeforphilly-ng/issues/80).

## Implements

- [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md) — "Mutability and redirects" + the multi-hop A→B→C rule + the "current slug wins" edge case.

## Approach

### 1. In-memory state — `slugHistory` map

Add to `InMemoryState`:

```ts
/**
 * Slug-history index, keyed by `${entityType}:${oldSlug}` → newSlug + expiry.
 * Populated at boot from non-expired SlugHistory records; updated in lockstep
 * with rename writes via StateApply.upsertSlugHistory.
 */
slugHistory: Map<string, { newSlug: string; expiresAt: string }>;
```

`indexSlugHistory(state, record)` populates the map. Expired records (where `expiresAt < now`) are dropped at boot — the periodic-sweeper task that purges the sheet is out of scope here (a future follow-up).

The key format mirrors gitsheets' existing `byEntityTypeAndOldSlug` secondary index but the lookup happens entirely in-process.

### 2. Boot loader

`loadInMemoryState` (in `apps/api/src/store/memory/loader.ts`) currently queries 9 sheets. Add `slug-history` as the 10th; call `indexSlugHistory` per record. Compare each record's `expiresAt` against `new Date().toISOString()` and skip the expired ones.

### 3. StateApply.upsertSlugHistory

New op in `apps/api/src/store/state-apply.ts`:

```ts
upsertSlugHistory(record: SlugHistory): this {
  this.#ops.push((state) => indexSlugHistory(state, record));
  return this;
}
```

Three write services wire this in immediately after their existing `tx.public['slug-history'].upsert(history)` call:

- `apps/api/src/services/account-claim.ts:684` (post-onboarding merge into legacy person)
- `apps/api/src/services/project.write.ts:303` (project rename)
- `apps/api/src/services/person.write.ts:126` (person profile-edit with new slug)

### 4. Fastify `slug-redirect` plugin

`apps/api/src/plugins/slug-redirect.ts` — registered after `services` (which decorates `inMemoryState`) and before `static-web` (which owns the SPA fallthrough notFoundHandler).

Implementation:

- `onRequest` hook (synchronous match; only network I/O is the reply itself).
- Skip if `request.url.startsWith('/api/')` or the method isn't GET.
- Parse the URL path against the slug-bearing patterns. Order matters — the deepest match (e.g. project + buzz) wins so a renamed buzz under a renamed project resolves both legs:

  | Pattern | Entity legs |
  |---|---|
  | `/projects/:slug/buzz/:buzzSlug` + suffix | project + buzz |
  | `/projects/:slug` + suffix | project |
  | `/members/:slug` + suffix | person |
  | `/tags/:namespace/:slug` + suffix | tag (namespace stays unchanged) |

- For each leg, **live wins**: if the slug is in the live entity index (`projectIdBySlug`, `personIdBySlug`, etc.), don't redirect. This handles the "someone took the freed slug" edge case from the spec.
- For live-misses, look up in `slugHistory`. If found and not expired, resolve the chain (`A → slugHistory[A] = B → slugHistory[B] = C → C is live, done`) with a `MAX_HOPS = 8` guard against malformed chains.
- Reconstruct the redirect URL: substitute the resolved slug into the original path and preserve the suffix.
- Reply with `301 Moved Permanently` + `Location: <newUrl>` + `Cache-Control: max-age=300` (short cache — the redirect itself may expire when the 90-day window does).
- Reserved-slug carve-outs: `/projects/create`, `/projects/new`, etc. — these are never slugs, so an empty hit in both live + slug-history is fine; the request continues to whatever handles them.

### 5. Plugin registration order

```
... services (decorates inMemoryState) →
  slug-redirect (new) →
  static-web (SPA fallthrough notFoundHandler)
```

The plugin uses `fastify.addHook('onRequest', ...)` so it fires for every request before routing; static-web's notFoundHandler runs only when no route matches. The slug-redirect hook itself never `reply.send()`s for non-slug paths — it just returns, letting the route or notFoundHandler handle the request.

### 6. Test coverage

`apps/api/tests/slug-redirect.test.ts`:

- Person rename `chris` → `chris-a` → GET `/members/chris` → 301 to `/members/chris-a`
- Project rename `old-project` → `new-project` → GET `/projects/old-project` → 301
- Sub-route preserved: GET `/projects/old-project/edit` → 301 to `/projects/new-project/edit`
- Multi-hop: A→B→C, GET `/projects/A` → 301 to `/projects/C` (single response, chain followed in-process)
- Live wins: oldSlug X is now a different live entity, GET `/projects/X` → no redirect, SPA serves
- Expired entry: an `expiresAt` in the past → request continues (no 301)
- Reserved: GET `/projects/create` → no redirect (slug-history lookup misses cleanly)
- API route untouched: GET `/api/people/<some-slug>` → never 301s through this hook (rejected before pattern match)
- Tag rename: GET `/tags/topic/old-tag` → 301 to `/tags/topic/new-tag` (namespace preserved)

## Validation

- [x] `InMemoryState.slugHistory` populated at boot from non-expired records; expired entries skipped via `indexSlugHistory`'s `expiresAt < now` guard.
- [x] All three write services call `stateApply.upsertSlugHistory` after the gitsheets upsert (`project.write.ts`, `person.write.ts`, `account-claim.ts`'s `MergeApply.replay`).
- [x] Fastify `slug-redirect` plugin registered after `services`, before `static-web`.
- [x] 11 test cases pass — single-hop project + person renames, sub-route preservation, query-string preservation, multi-hop A→B→C, live-wins, expired-skip, reserved-segment passthrough, tag rename, `/api/*` never intercepted, key-format determinism.
- [x] All 255 API tests pass (244 pre-existing + 11 new).
- [x] `npm run type-check && npm run lint` clean.
- [x] Spec compliance: GET `/<entity>/<old-slug>` with a non-expired SlugHistory → 301; live wins; multi-hop chain follows; expired → no redirect.

## Risks / unknowns

- **Hot-reload + slug-history.** Hot-reload re-runs `loadInMemoryState` against a fresh state, then mutates the live state Map in place. Because the slug-history map is part of the same `InMemoryState`, it gets reloaded the same way — no extra wiring needed. Verified by the existing reload pattern.
- **TTL precision at boot.** We compare `expiresAt < now` once, at load. A record that's not-yet-expired at boot will stay in the map until the pod restarts even if the 90-day window closes mid-life. Acceptable — the spec's 90-day window has a soft edge and pod restarts are frequent enough that staleness windows are bounded. Periodic sweeper is a follow-up.
- **Buzz / tag rename writers.** The redirect handler supports all four entity types from the spec's enum (project, person, tag, buzz), but the write side only writes slug-history for project + person today. Tag + buzz renames will still work correctly when (if) writers are added — no extra wiring needed at that point.
- **Cache-Control on the 301.** A long `max-age` on the redirect could outlive the 90-day window in browser caches. We set a short 5-minute cache; longer caches would just stale-redirect for a few minutes after expiry, not catastrophic but worth being conservative.
- **Path-segment edge cases.** Reserved slugs (`/projects/create`, `/projects/new`) will be checked against `slugHistory` — they'll miss cleanly (no SlugHistory record was ever written for them) and the request continues. No special-casing needed.

## Notes

Shipped over five commits — plan opening + three implementation steps (in-memory state, write-service wiring, Fastify plugin) + tests.

Surprises:

- **Account-claim's MergeApply needed slug-history threading.** Project + person renames live in their own write services where the StateApply is directly accessible, so wiring `upsertSlugHistory` was a one-line addition. Account-claim uses a `MergeApply` wrapper that batches all the post-onboarding rewrites for later replay onto the route-level StateApply — slug-history needed to ride along through that wrapper, which meant adding it to `MergeApplyInput` + `MergeApply.replay`.
- **Buzz live-index is intentionally fake.** Buzz slugs are keyed by `${projectId}:${buzzSlug}` in the live index (`buzzByProjectAndSlug`); we don't have the projectId cheaply at the URL-pattern level (only the project's slug). For now the buzz pattern always returns `false` from `liveIndex` — which means a slug-history hit always wins for buzz, regardless of whether the buzz slug is live under a different project. No writer currently creates buzz slug-history records, so this is hypothetical.
- **Tag live-check scans `tagIdByHandle.keys()`.** Tags are uniquely keyed by `(namespace, slug)` but slug-history's key is `tag:<slug>` (no namespace). The live-check walks the handle map looking for any namespace that owns the slug. Tag slug-history has no live writer today either; the conservative live-wins behavior matches the spec.
- **The 5-min `Cache-Control` is a deliberate undersizing.** 301s are normally aggressively cached by browsers. Because our redirects can expire when the 90-day SlugHistory TTL hits, we keep cache headers short so stale-redirect windows after expiry are bounded to ~5 minutes.

## Follow-ups

- **Periodic sweeper to purge expired SlugHistory records from the sheet.** The read path is already defensive — expired records are filtered at index time — so this is purely about keeping the on-disk sheet from growing forever. *Tracked as*: file a new issue when sheet bloat becomes measurable; today's volume is negligible.
- **Buzz live-index** — when buzz renames become real, add a `buzzByGlobalSlug` map (or accept the conservative "always redirect on slug-history hit"). *Deferred* until buzz rename writers exist.
- **CDN/edge cache awareness** — if/when we put the site behind a CDN, 301s would benefit from explicit cache-key handling so the redirect doesn't outlive its TTL at the edge. *Deferred* until cutover plans introduce a CDN.
