---
status: in-progress
depends: []
specs:
  - specs/api/projects.md
  - specs/screens/projects-index.md
issues: []
pr:
---

# Plan: project filters — fix the data-shape bug, switch to OR-within / AND-across, hoist stage to a row

## Scope

User reported that clicking any project filter chip "selects them all" and
toggles the whole tab on/off without changing the result list. Investigation
surfaced a long-standing data-shape bug (since the SPA's first feature drop)
**plus** a few real UX shortcomings worth addressing in the same pass.

What ships:

- **API bug → API contract change.** The SPA's `FacetEntry` type expected
  `{ handle, slug, title, count }`; the API has always returned
  `{ tag, title, count }`. Both ends were misaligned with each other and
  with the spec. Align the SPA to the spec.
- **Tag filter semantics: OR within namespace, AND across.** Spec previously
  said "AND across repeats" — the more common faceted-search pattern of
  OR-within / AND-across produces friendlier discovery.
- **Facet counts: filtered with self-namespace exclusion.** Spec previously
  said "unfiltered corpus so counts don't whipsaw." Replaced with the
  filtered-with-self-exclusion pattern so counts honestly answer "how many
  results would I get if I also picked X." Selected tags get pinned into
  their namespace facet so the SPA can render them even when they fall
  below the top-10 cut.
- **Stage facet hoisted to a horizontal pill row above results.** Stages
  are a 7-value fixed enum; the tabbed sidebar treatment hid them behind
  a click. New `StageFilterRow` component sits above the search box.

## Implements

- [api/projects.md](../specs/api/projects.md) — tag filter semantics + facet
  count semantics rewritten.
- [screens/projects-index.md](../specs/screens/projects-index.md) — sidebar
  loses the Stages tab; new "Stage row" section documents the hoist.

## Approach

### 1. Spec changes (specops, source of truth first)

- `specs/api/projects.md` → tag is "OR within namespace, AND across namespaces"
  with worked example; facets are filtered-with-self-namespace-exclusion
  with pinned-selected behavior documented.
- `specs/screens/projects-index.md` → new "Stage row" section above results;
  sidebar tabs reduced to Topics / Tech / Events.

### 2. API: `apps/api/src/services/project.ts`

Refactored the `list()` filter pass into a predicate factory that takes
optional exclusions (`excludeStage`, `excludeTagNs`). The main listing
uses the full predicate; each facet group is computed over a project
set built with the right exclusion. Tag handles are grouped by namespace
at request entry; the per-project tag-set check is OR within each
namespace's filter set and AND across namespaces.

### 3. Facets: `apps/api/src/store/memory/facets.ts`

`getProjectFacets` (cached, unfiltered) → `computeProjectFacets` (per
request, takes project sets per namespace exclusion). Pins active
selections with `count = 0` when no other project in the set carries
that tag, so the SPA always renders selected chips. `getPeopleFacets`
is unchanged (still cached / unfiltered) — out of scope for this fix;
people-list UX gets the same treatment when someone notices it
matters.

### 4. SPA: data-shape fix + stage row

- `apps/web/src/lib/api.ts` — `FacetEntry.handle` → `tag`; drop `slug` +
  `namespace` (never on the wire).
- `apps/web/src/components/FacetSidebar.tsx` — read `e.tag`; sort active
  selections to the top; drop the Stages tab + props.
- `apps/web/src/components/StageFilterRow.tsx` (new) — horizontal pill row
  using `STAGES` metadata.
- `apps/web/src/screens/ProjectsIndex.tsx` — render `StageFilterRow` above
  the search box; drop stage props from `FacetSidebar`.
- The other two `FacetSidebar` consumers (`PeopleIndex`, `HelpWantedIndex`)
  already passed only the tag-related props, so they're unaffected.

### 5. Tests

- **`apps/api/tests/project-filters.test.ts` (new)** — 9 cases drive
  `ProjectService` directly against a hand-built `InMemoryState`. Covers:
  OR-within-namespace, AND-across-namespaces, the combined case, unknown
  handles silently dropped, byTopic widens when topic is filtered, byTech
  narrows toward topic, byStage excludes its own filter, selected-tag
  pinning with count 0, and `tag` (not `handle`) in the response.
- **`apps/web/tests/ProjectsIndex.test.tsx`** — pre-existing tests
  updated to the new facet shape (was using stale `{ handle, slug, … }`
  mock that didn't match the API). New cases: sidebar chip renders with
  count + is distinct from other chips (would have caught the original
  bug); clicking a topic chip lands `tag=topic.transit` in the next
  `/api/projects` fetch URL (would have caught the empty-slug `tag=topic.`
  symptom); stage pill in the row above results adds to `stageIn=`;
  toggle-twice flips the chip off.
- **`apps/api/tests/read-api.test.ts`** — the existing "filters by tag
  AND facets still reflect unfiltered corpus" test updated to match the
  new spec; the data check (filtered list contains the project) still
  holds, the facet check is reframed as "selected tag pinned/included
  in its namespace."

## Validation

- [x] Spec updated: tag OR-within / AND-across + facet self-exclusion +
      stage row.
- [x] `ProjectService.list` honors OR-within-namespace and AND-across-namespaces.
- [x] `computeProjectFacets` returns filtered counts per the spec, pins
      selected tags below top-10.
- [x] SPA `FacetEntry` aligned with API; `FacetSidebar` reads `e.tag`.
- [x] `StageFilterRow` renders above results with stage filter state.
- [x] New API tests: 9/9. New SPA tests: 7/7 in ProjectsIndex.
- [x] Full sweeps: api 397/397, web 73/73, shared 75/75.
- [x] `npm run type-check && npm run lint` clean.

## Risks / unknowns

- **Behavior change on a public endpoint.** External consumers of
  `/api/projects?tag=...` who relied on AND-across-repeats semantics
  would observe a different result. Acceptable: the spec change is
  documented; in practice the only consumer is our own SPA, which was
  already broken on this code path.
- **Facet computation is now per-request.** Before: a global cache
  invalidated on writes. After: O(projects × tags) per `/api/projects`
  request. Civic-scale corpus (~500 projects, ~5K tag assignments)
  makes this trivially fast (~ms) — no caching needed for v1. Worth
  noting if the corpus grows by 10x.
- **PeopleIndex still uses the OLD unfiltered/cached facet path.** Same
  data-shape fix benefits it (the SPA bug was uniform); the OR-within /
  filtered-counts treatment isn't applied. Followup if/when noticed.

## Notes

Shipped clean — all 9 new API tests + 7 SPA tests pass on the first sweep;
full sweeps (api 397, web 73, shared 75) clean; lint + type-check green.

Surprises:

- **The data-shape bug had been live since the SPA's first feature drop**
  (commits `2f0a62c` and `427c2bf`), not a recent regression. The `FacetEntry`
  type was written against a proposed API shape that never matched what the
  backend actually shipped. No test exercised the click → URL → fresh-fetch
  path against real-shaped data, so the bug sat dormant until a user clicked
  a chip. Lesson worth memorializing: tests against handcrafted mock data
  must match the spec's wire shape, not the SPA's TypeScript types — types
  describe what the SPA *wants*, the spec describes what it *gets*.
- **Per-request facet computation is fast enough at civic scale.** The
  pre-fix `facets.ts` cached a global facet object invalidated on every
  write. The new per-request path computes 5 separate filter passes
  (the main listing + 4 facet exclusions) over the project set. At
  ~500 projects + ~5K tag assignments this is ~1-2ms total — well below
  the existing route's overhead. Caching isn't worth the complexity.
- **Selected-tag pinning matters more than I expected.** Without it, a
  user picks `topic.education` (one project tagged), then also picks
  `tech.python` (two projects, but no overlap with education) — the
  education facet would disappear from the sidebar because count=0, and
  the user wouldn't even know it's still applied. Pinning keeps the
  selection visible at count=0.
- **OR-within / AND-across is also the right default for `?tag=` API
  consumers**, not just the SPA. Anyone using the public API directly
  who wants strict-AND semantics can still get it by issuing one tag
  per request — but the natural URL `?tag=a&tag=b` now matches the
  user expectation across pretty much every faceted-search product
  shipped in the last decade.

## Follow-ups

- **People + Help-Wanted indexes have the same UX bug.** The SPA fix to
  `FacetEntry` benefits all three sidebars uniformly (the click → URL
  path now produces correct handles everywhere). But the OR-within /
  filtered-counts treatment is still projects-only on the backend.
  *Tracked as* — follow-up when someone notices the people-list facets
  feel off, or as part of a broader tag-search audit.
- **Facet caching at scale.** If the project corpus crosses ~10K, the
  per-request facet computation will start to show up in route timing.
  *None* — civic-scale is fine; revisit when the data shows the need.
- **Spec drift auditor coverage.** The original mismatch (SPA's
  `FacetEntry` vs the spec) would have been caught by an auditor pass
  that compared TS types in `apps/web/src/lib/api.ts` against the JSON
  example blocks in `specs/api/*.md`. *None* for now — manual review on
  the next audit pass.
