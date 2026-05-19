---
status: in-progress
depends: []
specs:
  - specs/data-model.md
  - specs/behaviors/storage.md
issues: [47, 56, 58]
---

# Plan: Importer cleanup trio

## Scope

Three small importer-and-schema fixes surfaced by the legacy-import dry run and the account-claim test, bundled because they're each tiny on their own but share the spec-→-importer surface. Together they reduce data loss on the published branch and document one gitsheets-internal limitation that nipped a test pattern.

- **#56** — relax `ProjectBuzz.url` so the importer stops dropping 81 of 113 records on `http://` URLs (legitimate historical press links).
- **#58** — default tags with no resolvable namespace to `topic` instead of skipping ~120 of them.
- **#47** — document the gitsheets `Sheet#dataTree` staleness limitation that the account-claim test stumbled into; verify no live exposure; file upstream for a future refresh API.

## Implements

- [data-model.md#projectbuzz](../specs/data-model.md#projectbuzz) — drop the `https://` requirement on `ProjectBuzz.url`; allow any valid URL.
- [data-model.md#tag](../specs/data-model.md#tag) — note that the importer defaults unnamespaced legacy handles to `topic`, with an audit-friendly warning log.
- [behaviors/storage.md](../specs/behaviors/storage.md) — add a section on the gitsheets dataTree-caching limitation and the in-memory-state pattern that bypasses it.

## Approach

### A. #56 — relax `ProjectBuzz.url` to any valid URL

The current schema (`packages/shared/src/schemas/project-buzz.ts:13`) enforces `z.string().url().startsWith('https://')`. Eighty-one of 113 laddr buzz records have `http://` URLs to mid-2010s press articles that are still served as plain HTTP on `codeforphilly.org` today. The fidelity loss outweighs the marginal security value of refusing them.

- **Schema change**: drop the `.startsWith('https://')` on `ProjectBuzz.url`. Keep `.url()` validation.
- **Importer change**: drop the `validHttps` fallback in `apps/api/scripts/import-laddr/translators.ts` for the buzz translator; pass through any well-formed URL.
- **Spec change**: in `specs/data-model.md#projectbuzz`, update the `url` row to drop the protocol requirement, with a note that historical `http://` URLs are preserved.
- **Web behavior**: confirm the buzz feed renders `http://` URLs (no `target="_blank" rel="noopener"` issues, no Content-Security-Policy bumps). The links render as ordinary `<a href>` already.

### B. #58 — default unnamespaced tags to `topic`

Current importer (`translators.ts:222–251`) skips any tag whose handle has no `topic.`/`tech.`/`event.` prefix and whose `Title` doesn't supply one. ~120 tags hit this — mostly low-traffic org/event keywords (`naloxone`, `cocoa`, `organizing_team`).

- **Importer change**: in `splitTagHandle`, when neither handle nor title yields a valid namespace, default to `{ namespace: 'topic', slug: handleNormalized }` and emit a `[tags] legacyId=<n> handle "<x>" had no resolvable namespace; defaulted to topic` warning. Keep the existing `tryFrom` recovery logic intact — namespaced handles still resolve to their explicit namespace.
- **Spec change**: in `specs/data-model.md#tag`, add a short "legacy import" note that handles without a namespace land in `topic`, callable out as an audit-friendly default that operators can re-namespace later via a tag-rename tool (out of scope here).
- No schema change — `Tag.namespace` remains the `topic | tech | event` enum.

### C. #47 — document the gitsheets `Sheet#dataTree` staleness limitation

Investigation (out-of-band agent): every gitsheets `Sheet` instance caches its `dataTree` snapshot at `openStore` time. After `repo.transact` commits a new tree, the standing `Sheet` objects in `store.public` still point at the pre-commit tree, so `sheet.query()` / `queryAll()` / `findByIndex()` calls return stale data. The hot-reload path already addresses this via `Store.swapPublic` (`apps/api/src/store/store.ts:60–81`).

Live production exposure: **none today.** No route handler reads from `slug-history` or `revocations` via gitsheets after a write in the same request. `InMemoryRevocationStore` operates on its own Maps; the future slug-history redirect handler will need to use an in-memory map too (the same pattern as `people`).

- **Documentation**: add a "Direct gitsheets reads after a transact" section to `specs/behaviors/storage.md` explaining the limitation and the in-memory-state pattern. Tighten the JSDoc on `Store.swapPublic` to mention this.
- **Test ergonomics**: the failing account-claim test stays on the `git show HEAD:…` fallback for now — the comment in the test gets updated to point at the new spec section instead of describing the symptom.
- **Upstream**: file a gitsheets enhancement request for an explicit per-sheet or per-store `refresh()` API. Add the issue link to the spec section.
- **No runtime code change** in this plan beyond the JSDoc.

## Validation

- [ ] `packages/shared/src/schemas/project-buzz.ts` — `url` no longer constrained to `startsWith('https://')`; type-check passes.
- [ ] `apps/api/scripts/import-laddr/translators.ts` — buzz translator passes through any well-formed URL; tag splitter defaults to `topic` with a warning.
- [ ] Re-run the importer against the legacy snapshot. Compare counts before/after:
  - ProjectBuzz: 32 → 113 (or whatever the post-fix count is — full 113 if every `http://` URL parses).
  - Tag skips: ~120 → 0 (all now imported as `topic`).
- [ ] `npm run -w apps/api test` — existing account-claim test (still using `git show`) passes; importer tests pass; no regressions elsewhere.
- [ ] `npm run type-check && npm run lint` clean.
- [ ] `specs/data-model.md` reflects ProjectBuzz + Tag changes; `specs/behaviors/storage.md` has the new dataTree-staleness section.
- [ ] Upstream gitsheets issue filed; link recorded in the storage.md section.
- [ ] Sandbox: after a deploy with the new importer's output merged into `published`, the project-detail pages with buzz feeds render the previously-skipped buzz items.

## Risks / unknowns

- **`http://` content-security**: a few of the 81 newly-imported buzz items may link to destinations that now serve malware or have been domain-squatted. Out of scope for this plan; future moderation tooling will need to handle this regardless of the URL protocol. Acceptable risk for the import.
- **Default-to-topic taxonomy drift**: adding ~120 noise tags to the `topic` namespace pollutes browsing surfaces that filter by namespace. Mitigation: the warning log makes the legacy ones enumerable, and the future tag-rename tool can re-classify them. Acceptable in exchange for not losing tag data.
- **Upstream gitsheets fix timing**: filing an enhancement is no-commitment work for that maintainer. The doc-and-pattern approach gives us a path that doesn't depend on it.

## Notes

_(filled at done time)_

## Follow-ups

_(filled at done time)_
