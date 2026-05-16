---
status: done
depends: [api-skeleton]
specs:
  - specs/api/projects.md
  - specs/api/people.md
  - specs/api/tags.md
  - specs/api/projects-updates.md
  - specs/api/projects-buzz.md
  - specs/api/projects-help-wanted.md
  - specs/api/projects-members.md
  - specs/behaviors/activity-feed.md
  - specs/behaviors/markdown-rendering.md
issues: []
pr: 22
---

# Plan: Read API

## Scope

Every documented `GET` endpoint across projects, people, tags, and sub-resources. Plus the SQLite FTS index used by `?q=` parameters. Plus the response-shape rendering that goes from in-memory state to the envelope.

Out of scope: any `POST`/`PATCH`/`DELETE` — those land in [`write-api`](write-api.md). Authentication is handled by [`auth-jwt-substrate`](auth-jwt-substrate.md); GET endpoints typically don't require it but check `request.session` for `permissions` hint computation.

## Implements

- All `GET` endpoints in:
  - [api/projects.md](../specs/api/projects.md) — list (with facets), detail
  - [api/people.md](../specs/api/people.md) — list, detail
  - [api/tags.md](../specs/api/tags.md) — list, detail, projects-on-tag, people-on-tag
  - [api/projects-updates.md](../specs/api/projects-updates.md) — list, detail, global feed
  - [api/projects-buzz.md](../specs/api/projects-buzz.md) — list, detail, global feed
  - [api/projects-help-wanted.md](../specs/api/projects-help-wanted.md) — list, global browse
  - [api/projects-members.md](../specs/api/projects-members.md) — no `GET` of its own; memberships render inside the project detail
- [behaviors/activity-feed.md](../specs/behaviors/activity-feed.md) — server-side returns the typed lists; the merge is client-side per spec
- [behaviors/markdown-rendering.md](../specs/behaviors/markdown-rendering.md) — every prose field's `*Html` and `*Excerpt` are derived from `*Source` via the [`storage-foundation`](storage-foundation.md) pipeline

## Approach

### Routing layout

`apps/api/src/routes/` mirrors `specs/api/`:

```
routes/
├── projects.ts             — /api/projects[, /:slug]
├── projects-members.ts     — under /api/projects/:slug/members (read of memberships in detail)
├── projects-updates.ts     — /api/projects/:slug/updates[, /:number], /api/project-updates
├── projects-buzz.ts        — /api/projects/:slug/buzz[, /:buzzSlug], /api/project-buzz
├── projects-help-wanted.ts — /api/projects/:slug/help-wanted, /api/help-wanted
├── people.ts               — /api/people[, /:slug]
└── tags.ts                 — /api/tags[, /:handle, /:handle/projects, /:handle/people]
```

Each route declares Zod schemas for query + response so OpenAPI auto-generates.

### Service layer

Routes are thin. Real work in `apps/api/src/services/`:

- `ProjectService.list({ q, stage, tag, sort, page, perPage, helpWanted, memberSlug, maintainer, featured })` — returns `{ items, total, facets }`. Filters apply to the in-memory `Map<id, Project>` using the secondary indices built in `storage-foundation`. Sort is a JS comparator. Pagination slices the filtered list.
- `ProjectService.get(slug)` — fetch by `bySlug.project`, hydrate memberships, tags, open help-wanted, computed permissions for the caller.
- `PersonService`, `TagService`, `ProjectUpdateService`, `ProjectBuzzService`, `HelpWantedService` — analogous.

Services consume the in-memory state from `storage-foundation`; they don't open a transaction (read-only).

### Full-text search

`apps/api/src/store/fts.ts` builds the SQLite FTS5 index at boot from the in-memory state:

```typescript
const db = new Database(':memory:');
db.exec(`CREATE VIRTUAL TABLE projects_fts USING fts5(slug, title, summary, overview)`);
// insert one row per Project (latest overview source post-render)
```

On mutation (from `write-api`), the FTS row is upserted. `Service.list({ q })` runs the MATCH query against the index, gets back ranked `slug` results, then materializes from the in-memory `Map`.

Fallback if `better-sqlite3` is unavailable on a deploy target: a MiniSearch-based variant behind the same interface. The route layer doesn't know which.

### Permission hints

`Project.permissions` (and other entities' `permissions`) computed per response using `request.session.person` + `accountLevel`. Centralized in `apps/api/src/services/permissions.ts` since the rules cross entity boundaries.

### Facet computation

The `metadata.facets` for projects lists is computed against the **unfiltered** corpus (per [api/projects.md](../specs/api/projects.md)) — so the sidebar counts don't whipsaw on filter. Cached in memory; invalidated when any project or tag-assignment mutates.

### Response shape rendering

`apps/api/src/services/serializers/` — one file per entity. Converts the in-memory record to the documented response shape (`ProjectListItem`, `Project`, `PersonListItem`, `Person`, etc.) including the `*Html` / `*Excerpt` markdown-derived fields and the `permissions` block.

## Validation

- [x] `GET /api/projects` returns the documented shape including `metadata.facets`
- [x] `GET /api/projects?stage=prototyping&tag=tech.flutter` filters correctly; `metadata.facets` still reflects the unfiltered corpus
- [x] `GET /api/projects?q=balancer` returns matching projects via FTS
- [x] `GET /api/projects/squadquest` returns the full Project shape including memberships, tags, open help-wanted, and `permissions`
- [x] `GET /api/projects/nope` returns `404 not_found`
- [x] `GET /api/people`, `/api/tags`, all sub-resource GETs return their documented shapes
- [x] Pagination: `?page=2&perPage=10` returns the right slice; `metadata.totalItems` is the unfiltered count
- [x] Sort: `?sort=-updatedAt` honored; unknown sort key → `422 validation_failed`
- [x] `?tag=tech.flutter` filters; multiple `?tag=...&tag=...` AND-combine
- [x] Markdown fields (`overviewHtml`, `bodyHtml`, etc.) come back HTML-sanitized
- [ ] `permissions.canEdit` flips correctly between anonymous, member, maintainer, staff for the project-detail response
- [x] Tests exercise every endpoint with at least one fixture-seeded happy path + one not-found / validation error

## Risks / unknowns

- **FTS native dep.** `better-sqlite3` ships native bindings that may or may not be available on every deploy target. Fallback to MiniSearch is the safety net. Decide at deploy time.
- **Facet computation cost.** O(records) per facet on every list response — but cached and only invalidated by mutation; should never be the bottleneck.
- **Cascading reads in `Project.get` (memberships + tags + help-wanted).** All in-memory; should be sub-millisecond. Profile if a project page is slow.

## Notes

- The `permissions.canEdit` flips-across-roles criterion is verified only for the anonymous case (`canEdit === false`) in the tests on this branch; the member/maintainer/staff axes require an authenticated request, which depends on `auth-jwt-substrate` populating `request.session.person`. The `computeProjectPermissions` logic in `services/permissions.ts` covers all four roles and is unit-testable once write-api or auth integration tests can mint a session. Logic-level test will close out alongside `write-api`.
- Vitest file parallelism is **disabled** for `apps/api` (`fileParallelism: false`). Parallel file execution caused flakes for gitsheets-backed tests; serial files keep tests deterministic and individual file runtime is already dominated by gitsheets boot. Revisit if/when boot becomes negligibly fast.
- The project-facet cache is module-scoped and invalidated on every services-plugin boot, so multiple `buildApp()` calls in tests see fresh state. `write-api` will additionally call `invalidateFacets()` from `store/memory/facets.ts` after mutations that change projects, tag-assignments, or stages.
- The FTS engine builds in-process at boot from the in-memory state via `better-sqlite3`. The MiniSearch fallback documented in the spec is **not** implemented — when the native dep is unavailable on a deploy target we'll surface the error rather than silently degrade. See follow-ups.
- The `apps/api/src/lib/session.ts` shim that this PR originally introduced (when read-api and auth-jwt-substrate were running in parallel) was removed at rebase time, since `auth-jwt-substrate` landed first and provides the real `request.session` decorator. `getCallerSession()` now lives in `services/permissions.ts` and derives the `CallerSession` from the real `request.session.person` (a full `Person` record).

## Follow-ups

- Deferred to [`write-api`](write-api.md) — verify `permissions.canEdit` flips for member/maintainer/staff on the project-detail response with an authenticated request once write-api can mint sessions in tests.
- Deferred to [`write-api`](write-api.md) — call `invalidateFacets()` from `store/memory/facets.ts` and the FTS upsert/remove methods on `apps/api/src/store/fts.ts` after every project, tag-assignment, person, and help-wanted-role mutation.
- Issue [#23](https://github.com/CodeForPhilly/codeforphilly-ng/issues/23) — decide MiniSearch fallback strategy for `better-sqlite3` (current behavior: surface the error rather than silently degrade)
