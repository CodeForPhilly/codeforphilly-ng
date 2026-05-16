# Behavior: Legacy ID Mapping

## Rule

The rewrite migrates rows from the laddr MySQL database into Postgres while preserving every URL that resolves to a public resource. The bridge is a `legacyId` column on each migrated table that holds the laddr auto-increment primary key.

## Applies To

- [data-model.md](../data-model.md) — `legacyId` column on `people`, `projects`, `projectUpdates`, `projectBuzz`, `tags`, `projectMemberships` (and any other migrated table)
- The one-shot importer (`apps/api/scripts/import-laddr.ts` — implementation, not spec)
- The web layer's legacy-URL redirect handler (described below)

## What `legacyId` is for

1. **Migration idempotence** — running the importer twice doesn't create duplicates. The importer upserts on `legacyId`.
2. **Legacy URL redirects** — laddr URLs sometimes referenced numeric IDs (in `?MemberID=42` query strings, in RSS GUIDs). The rewrite resolves those to the modern slug-based URL by `legacyId` lookup.
3. **Cutover validation** — staff can spot-check that row counts and individual records match between the two systems.

## When `legacyId` is null

After cutover, all new rows created via the API have `legacyId = null`. This is normal. The `legacyId` indexes are partial — `where legacyId is not null` — so they only cost storage for migrated rows.

If we ever need to re-import (e.g., catching up on changes made after cutover), the importer matches existing rows by `legacyId` and updates them in place rather than duplicating.

## Indexes

```sql
create unique index projects_legacy_id_idx     on projects(legacyId)     where legacyId is not null;
create unique index people_legacy_id_idx       on people(legacyId)        where legacyId is not null;
create unique index project_updates_legacy_id  on projectUpdates(legacyId) where legacyId is not null;
-- etc.
```

Partial unique — `null != null` in SQL so this works.

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

This file specifies the *contract* — that `legacyId` exists and is unique-where-non-null, and what URL patterns we resolve through it. The mapping table from each laddr column to each Postgres column is in [data-model.md#naming-map](../data-model.md#naming-map-laddr--rewrite). The actual import script's behavior (error handling, ordering, batch size) is implementation detail and lives in code, not spec.
