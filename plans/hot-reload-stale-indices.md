---
status: in-progress
depends: []
specs:
  - specs/behaviors/storage.md
  - specs/behaviors/legacy-id-mapping.md
  - specs/behaviors/slug-handles.md
issues: []
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

- [ ] `specs/behaviors/storage.md` hot-reload Atomicity bullet names every
      collection including legacy-id, buzz-by-slug, slug-history.
- [ ] `swapInPlace` replaces every own property of `InMemoryState` without
      an explicit per-field list.
- [ ] Unit test enumerates every collection field of a fresh state and
      asserts the swap replaced each one; fails on the pre-fix code.
- [ ] Integration test: after re-import + webhook, `/projects?ID=<n>`,
      `/project-buzz/<slug>`, and old-slug URLs 301 to the new slug.
- [ ] `npm run type-check && npm run lint && npm test` clean from repo root.

## Risks / unknowns

- **A future non-Map field on `InMemoryState`.** The enumerating swap
  throws if it meets one. That is deliberate: the author of the new field
  has to decide how it is swapped, and the unit test surfaces the
  question immediately.
- **Concurrent branch touching `apps/api/src/notify/*`, `plugins/services.ts`,
  `env.ts`.** This plan does not touch those files.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
