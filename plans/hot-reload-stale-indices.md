---
status: done
depends: []
specs:
  - specs/behaviors/storage.md
  - specs/behaviors/legacy-id-mapping.md
  - specs/behaviors/slug-handles.md
issues: []
pr: 159
---

# Plan: hot reload leaves three secondary indices stale

## Scope

`swapInPlace` in `apps/api/src/store/memory/reload.ts` replaces the
contents of every Map on `InMemoryState` by an explicit, hand-maintained
list of `replaceMapContents` calls. Three indices were never added to that
list: `projectIdByLegacyId`, `buzzIdBySlug`, and `slugHistory`. After the
hot-reload webhook (`POST /api/_internal/reload-data`) those three still
hold pre-reload contents.

The user-visible consequence: the laddr importer mints fresh UUIDv7 ids on
every run, so a re-import merged into `published` followed by a hot reload
leaves `projectIdByLegacyId` pointing at project ids that no longer exist.
Legacy `/projects?ID=<n>` and `/project-updates?ProjectID=<n>` redirects
fall through to the SPA (404) until the pod restarts. Buzz-by-slug
(`/project-buzz/<slug>`) and slug-history 301s go stale the same way.

In scope:

- Spec: make the hot-reload atomicity rule say *every* collection is
  replaced, naming the three indices that were missed.
- Fix `swapInPlace` so it cannot omit a field again.
- Tests that (a) enumerate every collection on a freshly built state and
  assert the swap replaced it, and (b) drive the real webhook through a
  re-import scenario and assert the legacy and slug-history redirects
  follow the new records.

Out of scope: anything about the reconcile state machine, the FTS reload,
or the push daemon. Those paths were not affected.

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md) — Hot reload →
  Atomicity: every collection on the live state is replaced from the fresh
  one, including legacy-id, buzz-by-slug, and slug-history indices.
- [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md)
  — legacy redirects resolve against current records after a reload.
- [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md) —
  slug-history redirects resolve against current records after a reload.

## Approach

1. **Spec first.** One sentence added to the Atomicity bullet of the
   hot-reload section.
2. **Enumerate, don't list.** Replace the hand-maintained list in
   `swapInPlace` with a loop over `Object.keys(fresh)`. Every own property
   of `InMemoryState` is a Map today; the loop asserts that at runtime and
   throws a descriptive error if a future field is something else, so a
   new non-Map field fails loudly in the test suite rather than being
   silently skipped. Nested `Set` values inside index Maps are copied by
   reference from `fresh`, which is correct — `fresh` is discarded after
   the swap and nothing else holds those Sets.
3. **Unit guard.** New `apps/api/tests/reload-swap.test.ts` builds two
   `InMemoryState`s from different hand-crafted records (different ids,
   legacy ids, slugs, slug-history entries), swaps, and for every own
   property of the fresh state asserts `live[key]` deep-equals
   `fresh[key]` while `live` keeps its object and Map identities. Also
   checks that the three previously stale indices no longer resolve the
   old values.
4. **Integration guard.** Extend `apps/api/tests/internal-reload.test.ts`
   with a re-import scenario: seed a project carrying `legacyId`, boot,
   confirm the legacy redirect; advance the remote by deleting that
   record and writing a replacement with a fresh id and slug plus a
   slug-history record; fire the webhook; assert the legacy redirect,
   the buzz redirect, and the slug-history redirect all point at the new
   slug.

## Validation

- [x] `specs/behaviors/storage.md` hot-reload Atomicity bullet names every
      collection including legacy-id, buzz-by-slug, slug-history.
- [x] `swapInPlace` replaces every own property of `InMemoryState` without
      an explicit per-field list.
- [x] Unit test enumerates every collection field of a fresh state and
      asserts the swap replaced each one; fails on the pre-fix code.
- [x] Integration test: after re-import + webhook, `/projects?ID=<n>`,
      `/project-buzz/<slug>`, and old-slug URLs 301 to the new slug.
- [x] `npm run type-check && npm run lint && npm test` clean from repo root.

## Risks / unknowns

- **A future non-Map field on `InMemoryState`.** The enumerating swap
  throws if it meets one. That is deliberate: the author of the new field
  has to decide how it is swapped, and the unit test surfaces the
  question immediately.
- **Concurrent branch touching `apps/api/src/notify/*`, `plugins/services.ts`,
  `env.ts`.** This plan does not touch those files.

## Notes

- **Diagnosis confirmed as stated.** Diffing the Map-typed fields of
  `InMemoryState` against the `replaceMapContents` calls showed exactly the
  three missing: `projectIdByLegacyId`, `buzzIdBySlug`, `slugHistory`. All
  three are plain Maps (slug-history values are `{ newSlug, expiresAt }`
  objects, no nested Sets), so the same copy-by-reference swap is correct
  for them. No Set-typed top-level fields exist.
- **The unit test failed 3/4 on the old code** (identity test passes
  either way); the webhook re-import test failed at the post-reload legacy
  redirect (404 instead of 301). Both verified by temporarily restoring the
  pre-fix `reload.ts`.
- **Boot-order gap found along the way.** `store` opens the gitsheets
  Sheet snapshots before `reconcile` fast-forwards, and `services` builds
  the in-memory state from those stale snapshots. Only bites when the
  local clone is behind at boot (dev, tests) — production pods clone fresh.
  The re-import test works around it with an explicit
  `git fetch origin main:main` before boot. Filed as #160.
- **Web test flakes under load.** `ProjectEdit` and `ExpressInterestModal`
  timed out once while `npm test` ran concurrently with type-check + lint;
  both pass on their own and on a quiet full `npm test -w apps/web` run.
  Unrelated to this change (no `apps/web` files touched).

## Follow-ups

- Issue [#160](https://github.com/CodeForPhilly/codeforphilly-ng/issues/160)
  — boot-time reconcile should re-open the store snapshot (or open the
  store after reconcile) so a behind-at-boot clone doesn't build
  in-memory state from the pre-fast-forward tree.
