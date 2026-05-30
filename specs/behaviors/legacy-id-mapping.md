# Behavior: Legacy ID Mapping

## Rule

The rewrite migrates records from the live laddr site at `codeforphilly.org` into gitsheets while preserving every URL that resolves to a public resource. The bridge is a `legacyId` field on each migrated record that holds the laddr auto-increment primary key.

## Applies To

- [data-model.md](../data-model.md) — `legacyId` field on `people`, `projects`, `project-updates`, `project-buzz`, `tags`, `blog-posts` (the migrated sheets where laddr's auto-increment IDs were ever referenced externally; `project-memberships` is *not* in this list — laddr's `project_members.ID` never escaped to URLs)
- The re-runnable importer (`apps/api/scripts/import-laddr.ts` — implementation, not spec) which pulls the public dataset via laddr's `?format=json` endpoints
- The web layer's legacy-URL redirect handler (described below)
- [behaviors/storage.md](storage.md) — the import lands as snapshot commits on a `legacy-import` branch, which the operator merges into `main` to integrate updates

## What `legacyId` is for

1. **Migration idempotence** — running the importer twice doesn't create duplicates. Files on the `legacy-import` branch are keyed by `legacyId`, so a fresh snapshot overwrites the same paths; consecutive commits diff cleanly to show what changed upstream.
2. **Legacy URL redirects** — laddr URLs sometimes referenced numeric IDs (in `?MemberID=42` query strings, in RSS GUIDs). The rewrite resolves those to the modern slug-based URL by `legacyId` lookup.
3. **Cutover validation** — staff can spot-check that row counts and individual records match between the two systems.

## When `legacyId` is absent

After cutover, all new records created via the API have no `legacyId` field. This is normal.

If we ever need to re-import (e.g., catching up on changes made after cutover), the importer matches existing records by `legacyId` (looked up via the in-memory `byLegacyId` index) and updates them in place rather than duplicating.

## Lookup

`legacyId` lookups go through the in-memory `byLegacyId.<entity>` indices documented in [data-model.md](../data-model.md). These indices are built at boot by iterating the sheet and skipping records where `legacyId` is absent.

Uniqueness of `legacyId` per sheet is enforced by the API's write mutex: a record's `legacyId` is checked against the index before commit, just like `slug` and `email`.

## Legacy URL forms we accept

The web layer catches these patterns and 301s to the canonical URL:

| Legacy URL | Resolved as | Lookup |
| ---------- | ----------- | ------ |
| `/projects/:slug` | Current canonical | direct match (slugs preserved) |
| `/projects?ID=<n>` | `/projects/:slug` | `projects.legacyId = n` |
| `/people/:username` | `/members/:slug` | username = slug; static rewrite |
| `/members/:slug` | unchanged | – |
| `/project-updates?ProjectID=<n>` | `/projects/:slug` | by `legacyId` |
| `/project-buzz/<slug>` | `/projects/:projectSlug/buzz/<buzzSlug>` | buzz slugs preserved |
| `/tags/<handle>` | `/tags/<namespace>/<slug>` | split on `.` |

Patterns not listed (e.g., `/checkin`, `/bigscreen`) return 410 Gone with an explanation page (see [deferred.md](../deferred.md) for why those URLs no longer exist).

## When the importer runs

The importer is **not** a production-runtime concern, but it *is* re-runnable. While the legacy site is still the source of truth (pre-cutover and through the cutover window), the importer can be run any time to catch `legacy-import` up with the live data — each run produces a single new commit whose tree fully replaces the previous one, so consecutive commits diff cleanly to show what changed upstream. The operator merges `legacy-import` into `main` to integrate those updates.

After cutover, `legacyId` is read-only data and the importer is no longer run.

## Legacy resources captured at import time, not proxied at runtime

Some legacy data carries references to laddr-hosted **resources** — most prominently, blog post bodies that reference `https://codeforphilly.org/thumbnail/<id>/<dim>` images. These references are a cutover hazard: when laddr is decommissioned, every reference breaks.

The rule: **importers materialize legacy resources at import time** rather than leaving runtime URLs pointing at the legacy host. Two operations apply:

1. **Capture** the bytes — fetch the original from the legacy host, store as a gitsheets attachment scoped to the owning record (`<sheet>/<slug>/<filename>` per [storage.md](storage.md) attachments).
2. **Rewrite** every reference — scan the text where the reference lives (markdown bodies, HTML blocks, anywhere) and replace the legacy URL with the local `/api/attachments/<key>` URL.

Third-party URLs (YouTube embeds, external sites) pass through untouched — only `codeforphilly.org`-hosted resources need this treatment.

The current importer applies this to blog-post Media + Embed items. Project descriptions, project-update bodies, and person bios *do not* currently reference legacy media URLs in production (verified during cutover-blog work) — but the same import-time capture pattern would apply if they did.

## Spec coverage of migration mechanics

This file specifies the *contract* — that `legacyId` exists and is unique-where-present, and what URL patterns we resolve through it. The mapping table from each laddr column to each gitsheets field is in [data-model.md#naming-map](../data-model.md#naming-map-laddr--rewrite). The actual import script's behavior (endpoint discovery, pagination, full-tree-replace mechanics, file-naming on the `legacy-import` branch, `--dry-run` UX) is implementation detail and lives in code, not spec.
