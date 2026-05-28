---
status: done
depends: []
specs:
  - specs/behaviors/legacy-id-mapping.md
issues: [78]
pr: 93
---

# Plan: Legacy laddr URL redirects

## Scope

[`specs/behaviors/legacy-id-mapping.md`](../specs/behaviors/legacy-id-mapping.md) → "Legacy URL forms we accept" lists the laddr URL shapes the new site must continue serving. None are wired today — every external bookmark, indexed Google result, and Slack/Twitter link to the old site shapes 404s on next-v2 (and will 404 on `codeforphilly.org` at flip-time without this).

Five redirect patterns + a 410 carve-out for explicitly-deferred URLs:

| Legacy URL | Resolved to | Lookup |
|---|---|---|
| `/projects?ID=<n>` | `/projects/<slug>` | `projects.legacyId = n` |
| `/people/:username` | `/members/:username` | static rewrite — username = slug |
| `/project-updates?ProjectID=<n>` | `/projects/<slug>` | by project `legacyId` |
| `/project-buzz/<slug>` | `/projects/<projectSlug>/buzz/<slug>` | buzz slug is globally unique |
| `/tags/<namespace>.<slug>` (dot-form) | `/tags/<namespace>/<slug>` | pure URL transform, no lookup |
| `/checkin`, `/bigscreen` | `410 Gone` + explanation | deferred per [specs/deferred.md](../specs/deferred.md) |

Companion to [#80](https://github.com/CodeForPhilly/codeforphilly-ng/issues/80) (slug-history redirect — handles renames *within* the new site). This handles redirects *into* the new site from the old one.

Closes [#78](https://github.com/CodeForPhilly/codeforphilly-ng/issues/78).

## Implements

- [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md) — all 5 redirect rows + the 410 carve-out for deferred patterns.

## Approach

### 1. Two new in-memory indices

`InMemoryState` already has `projectIdBySlug`, `personIdBySlug`, `buzzByProjectAndSlug`. The legacy redirect needs:

- `projectIdByLegacyId: Map<number, string>` — for `/projects?ID=<n>` + `/project-updates?ProjectID=<n>`.
- `buzzIdBySlug: Map<string, string>` — for `/project-buzz/<slug>`. Buzz slugs are globally unique per `data-model.md#projectbuzz`, so a flat global map is the right shape.

People don't need a legacy-id index because the username → slug mapping is a static rewrite (laddr's `Username` was copied verbatim into `slug` on import per `behaviors/slug-handles.md#migration-from-laddr`).

Tags don't need an index because the dot-form → path-form transform is pure URL surgery (`topic.transit` → `topic/transit`) — no lookup.

`indexProject` populates `projectIdByLegacyId` when `record.legacyId` is set. `indexProjectBuzz` populates `buzzIdBySlug`. Boot loader picks them up via the existing `loadInMemoryState` flow without changes (the existing `indexProject` + `indexProjectBuzz` calls already fire for every record).

### 2. `legacy-redirect` Fastify plugin

`apps/api/src/plugins/legacy-redirect.ts` — registered after `services`, before `slug-redirect` (the order between the two doesn't matter operationally; both bypass `/api/*`).

Each pattern is encoded as a separate matcher; the hook tries them in order and replies 301 (or 410) on first hit. Patterns:

1. **`/projects?ID=<n>`** — match path `/projects` exactly + parse `request.query.ID`. Lookup `projectIdByLegacyId.get(Number(id))` → project; rebuild as `/projects/<project.slug>`.
2. **`/people/<username>...`** — regex `/^\/people\/([^/]+)(\/.*)?$/`. Rebuild as `/members/<username><suffix>`. No lookup; static prefix-rewrite.
3. **`/project-updates?ProjectID=<n>`** — match path `/project-updates` + parse `request.query.ProjectID`. Lookup project → `/projects/<slug>`.
4. **`/project-buzz/<slug>...`** — regex `/^\/project-buzz\/([^/]+)(\/.*)?$/`. Look up `buzzIdBySlug.get(slug)` → buzz; get `project.slug` from `projectSlugById`. Rebuild as `/projects/<projectSlug>/buzz/<slug><suffix>`.
5. **`/tags/<namespace>.<slug>...`** — regex `/^\/tags\/([a-z]+)\.([^/]+)(\/.*)?$/`. Pure transform — rebuild as `/tags/<namespace>/<slug><suffix>`.
6. **`/checkin`, `/bigscreen`** — exact match → `410 Gone` with a small explanation HTML body. Spec doesn't specify the exact body; we'll serve a minimal page linking to the current site root.

All redirects respond with `301` + `Location` + `Cache-Control: max-age=86400` (24h — legacy URL shapes are permanent and won't change between deploys; the cache is conservative but a full year would be presumptuous).

For unknown legacy-IDs (`?ID=99999` where no project exists), the hook returns without sending — request continues to the SPA fallthrough, which 404s. Spec doesn't require a different shape for "legacy ID not found"; treating it the same as any non-existent slug is consistent.

### 3. Plugin registration order

```
... services →
  legacy-redirect (new) →
  slug-redirect (existing) →
  static-web (SPA fallthrough)
```

Both `legacy-redirect` and `slug-redirect` are `onRequest` hooks; they each pattern-match disjoint URL shapes (the legacy patterns have query strings or dot-form or specific prefixes that the slug-redirect patterns never match). No coordination needed beyond "register them both."

### 4. Tests

`apps/api/tests/legacy-redirect.test.ts`:

- `/projects?ID=42` with project legacyId=42 → 301 to `/projects/<slug>`
- `/projects?ID=42` with no matching project → no redirect (passes through to SPA)
- `/projects?ID=notanumber` → no redirect (passes through; treat as garbage query)
- `/people/janedoe` → 301 to `/members/janedoe` (sub-route preserved: `/people/janedoe/edit` → `/members/janedoe/edit`)
- `/project-updates?ProjectID=7` → 301 to `/projects/<slug>` (lookups via projectIdByLegacyId)
- `/project-buzz/inquirer-praises-foo` → 301 to `/projects/foo-project/buzz/inquirer-praises-foo`
- `/tags/topic.transit` → 301 to `/tags/topic/transit`
- `/tags/tech.flutter` → 301 to `/tags/tech/flutter`
- `/tags/event.ecocamp-2014` → 301 to `/tags/event/ecocamp-2014`
- `/checkin` → 410
- `/bigscreen` → 410
- `/api/projects?ID=42` → no redirect (API path bypass)
- Query string preservation across the project lookup pattern: `/projects?ID=42&tab=updates` → `/projects/<slug>?tab=updates` (drops `ID` since it's now in the path, keeps other params)

## Validation

- [x] `projectIdByLegacyId` and `buzzIdBySlug` populated at boot via `indexProject` + `indexProjectBuzz`.
- [x] `indexProject` + `indexProjectBuzz` update both old- and new-index entries on upsert; `removeProject` + `removeProjectBuzz` ops in `state-apply.ts` clean up the new indices too.
- [x] Plugin registered in `app.ts` after `services`, alongside `slug-redirect`.
- [x] 19 test cases pass (covering all 5 redirect patterns + 410 + /api/* bypass + unknown-legacyId pass-through + sub-route + query-string preservation).
- [x] All 274 API tests pass (255 pre-existing + 19 new).
- [x] `npm run type-check && npm run lint` clean.

## Risks / unknowns

- **`?ID=` query-string parsing** — Fastify decodes query params for us, but bot traffic with arbitrary `ID` values (`<script>`, SQL-injection probes, etc.) is common. We treat non-numeric values as no-match → request continues; never bounce them as redirects or 410s.
- **The 410 HTML body** — spec says "with an explanation page" but doesn't specify shape. Minimal text/HTML is enough for v1; a future polish task could give them proper styled pages.
- **Buzz redirect needs both indices to be in sync** — `buzzIdBySlug` + `projectBuzz` (for the buzz record) + `projectSlugById` (for the project slug). All three already exist or will after this PR. If any one is stale, the redirect 404s through to the SPA — acceptable fallback.
- **Tag dot-form with multi-dot slugs** — `tags/topic.foo.bar` would match `<namespace=topic>.<slug=foo.bar>`. The regex's `([^/]+)` captures `foo.bar` as the slug, which is what we want (dots in slugs are unusual but not prohibited by `[a-z0-9-]` enforcement on the new system — though the laddr import would have produced `foo-bar` after sanitization). Edge case but the regex handles it.

## Notes

Shipped over four commits — plan opening + in-memory indices + plugin + tests.

Surprises:

- **`removeProject` + `removeProjectBuzz` needed legacy-index cleanup too.** Adding new in-memory indices means every place that mutates the corresponding maps needs to mirror — easy to miss on the remove side. Caught while reviewing state-apply.ts; the existing remove ops only cleared the slug indices, so the legacy indices would have leaked stale entries.
- **No `indexProjectBuzz` lookup-on-upsert** in the original code — when a buzz record changed `slug`, the old `buzzIdBySlug` entry would have stuck around. Fixed in the same edit (read `state.projectBuzz.get(buzz.id)` to find the old slug and delete it before re-indexing). Same shape as `indexProject` and `indexPerson`.
- **24-hour Cache-Control for 301s.** Slug-redirect uses 5min because the SlugHistory 90-day window can expire mid-life. Legacy URL shapes are *permanent* — they'll never change — so 24h is safe and reduces redirect-chain latency for recurring inbound links.
- **Unknown legacyIds fall through, never 410.** The hook treats `?ID=99999` (no matching project) the same as any unknown URL: pass through to the SPA. Treating it as 410 would imply "this used to exist," which we can't know.

## Follow-ups

- **Real explanation pages for /checkin and /bigscreen.** The minimal inline HTML the plugin serves today is fine but unstyled. A more polished 410 page is post-cutover polish. *Tracked as*: a Fastify route that serves a real `apps/web/src/screens/Gone.tsx` instead of inline HTML.
- **Additional 410 targets.** Other deferred laddr URL shapes — `/projects.csv`, `/project-updates?format=rss`, RSS feeds — currently fall through to the SPA which 404s. Whether to add them to the 410 list is a judgment call. *Deferred* until someone surfaces a specific request.
- **Cutover smoke** — at deploy time, exercise each redirect pattern against the live sandbox with realistic laddr inbound URLs (Google index, Slack share links, etc.). *Deferred to deploy time*.
