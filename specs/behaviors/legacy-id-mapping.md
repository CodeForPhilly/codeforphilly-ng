# Behavior: Legacy ID Mapping

## Rule

The rewrite migrates rows from the laddr MySQL database into gitsheets while preserving every URL that resolves to a public resource. The bridge is a `legacyId` field on each migrated record that holds the laddr auto-increment primary key.

## Applies To

- [data-model.md](../data-model.md) — `legacyId` field on `people`, `projects`, `project-updates`, `project-buzz`, `tags`, `project-memberships` (and any other migrated sheet)
- The one-shot importer (`apps/api/scripts/import-laddr.ts` — implementation, not spec)
- The web layer's legacy-URL redirect handler (described below)
- [behaviors/storage.md](storage.md) — the import is a single big commit on the data repo

## What `legacyId` is for

1. **Migration idempotence** — running the importer twice doesn't create duplicates. The importer upserts on `legacyId`.
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

The importer is **not** a production-runtime concern. It's run:

1. Once during initial development (against a dev copy of the laddr DB) to validate the schema mapping.
2. Once during the staging cutover dry-run.
3. Once for real at cutover.

After that, `legacyId` is read-only data.

## Spec coverage of migration mechanics

This file specifies the *contract* — that `legacyId` exists and is unique-where-present, and what URL patterns we resolve through it. The mapping table from each laddr column to each gitsheets field is in [data-model.md#naming-map](../data-model.md#naming-map-laddr--rewrite). The actual import script's behavior (error handling, ordering, batch size, choice of one-big-commit vs. one-commit-per-record) is implementation detail and lives in code, not spec.
