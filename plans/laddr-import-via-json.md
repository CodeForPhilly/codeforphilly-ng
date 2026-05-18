---
status: planned
depends: [laddr-import]
specs:
  - specs/behaviors/legacy-id-mapping.md
issues: []
---

# Plan: Laddr importer via JSON

## Scope

Build a re-runnable importer that pulls the full live laddr public dataset via `codeforphilly.org`'s `?format=json` endpoints and commits it as a complete snapshot to a `legacy-import` branch in the public data repo (`codeforphilly-data`). Each run produces one new commit whose tree fully **replaces** the previous one — the diff between consecutive commits is exactly what changed on the live laddr site. The `legacy-import` branch is then merged into `main` to integrate updates.

This **replaces** the mysqldump-based path from [`laddr-import`](laddr-import.md), which was specified, implemented, and merged but never actually run against production data. The mysqldump entry point and the SQL fixture are deleted; the field-mapping logic from `translators.ts` is adapted to the JSON shape.

Out of scope:

- **Private-field import** (emails, password hashes, legacy credentials). The `?format=json` endpoints expose public fields only. Private fields will be sourced separately on a future plan — either via an admin-authenticated export endpoint on laddr, or surfaced through the account-claim flow at first login.
- Cutover orchestration, slug-history capture, runtime API behavior.

## Implements

- [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md) — files are keyed by `legacyId`, the spec amended to drop "single big commit" + "MySQL" framing and describe the snapshot/merge model
- [data-model.md](../specs/data-model.md) — field mappings (translators adapted from `laddr-import` to JSON-shape inputs)

## Approach

### Branching model

```
legacy-import  o─o─o─o     each o is one run, tree = full snapshot of laddr
                \  \  \
main           o-o--o--o   merged forward periodically; non-legacy edits
                           on main survive because the merge only carries
                           what's under the importer's owned paths.
```

Each importer execution:

1. Check out `legacy-import` (create from `empty` if it doesn't exist yet — first run only).
2. `git rm -rf` every entity directory the importer owns (`people/`, `projects/`, `tags/`, `project-memberships/`, `project-updates/`, `project-buzz/`, `tag-assignments/`).
3. Fetch all records from `?format=json`, translate, write fresh TOML files keyed by `legacyId`.
4. `git add -A` → single commit with structured trailers (run-at, source-host, per-sheet counts).
5. Push to origin.

Operator then merges `legacy-import` → `main` in a separate, deliberate step. Standard git merge — conflicts on `main` (e.g., a rewrite-era edit to an imported record) get resolved manually.

### Stable filenames keyed by `legacyId`

Files live at `<sheet>/<legacyId>.toml` (e.g., `projects/1234.toml`, `people/567.toml`). Each record's internal `id` field stays UUIDv7 — only the filename is keyed on `legacyId` so re-runs overwrite the same path and diffs are interpretable. New-in-v1 records (e.g., `help-wanted-roles/`) keep their UUIDv7 paths under `main` only; the importer doesn't touch them.

Composite-path sheets (`project-memberships/<projectLegacyId>-<personLegacyId>.toml`, `tag-assignments/<tagLegacyId>-<targetType>-<targetLegacyId>.toml`) get equivalent legacyId-derived paths so re-imports are stable.

### Script entry point

`apps/api/scripts/import-laddr.ts` (replaces the existing mysqldump version):

```bash
npm run -w apps/api script:import-laddr -- \
  --source-host=codeforphilly.org \
  --data-repo=/Users/chris/Repositories/codeforphilly-data \
  --branch=legacy-import \
  [--dry-run] [--limit=N] [--no-commit] [--verbose]
```

Defaults: `--source-host=codeforphilly.org`, `--data-repo` from `CFP_DATA_REPO_PATH`, `--branch=legacy-import`.

`--dry-run` fetches + translates + reports without touching the data repo.
`--no-commit` writes files + adds to index but doesn't commit (for inspection).
`--limit=N` truncates each fetch (interactive dev).

### JSON sourcing

Endpoints to fetch (FK-order):

```
GET https://<source-host>/tags?format=json
GET https://<source-host>/people?format=json
GET https://<source-host>/projects?format=json
GET https://<source-host>/project-memberships?format=json
GET https://<source-host>/project-updates?format=json
GET https://<source-host>/project-buzz?format=json
GET https://<source-host>/tag-assignments?format=json
```

(Some of these may not exist or may differ in path — endpoint discovery is the first dev task. Hit each URL, capture the actual shape, adapt translators.)

Polite fetch: small delay between requests, descriptive `User-Agent: cfp-importer/<commit-sha>`. Validate every response body with a per-sheet Zod schema before passing to translators (laddr's JSON output is incidental, not a documented contract).

### Translation

Reuse `apps/api/scripts/import-laddr/translators.ts`. Where JSON field names differ from DB-row column names (likely camelCase vs `PascalCase` Emergence-style), adjust at the translator's input boundary, not at call sites.

Likely adaptations:

- Field naming conventions differ between Emergence's JSON output and its DB columns
- Stage values may already be normalized in the JSON
- Tag handle splitting (`topic.transit` → `namespace=topic, slug=transit`) still applies
- `tag_items.ContextClass` may render differently in JSON

### Commit shape

```
import: snapshot from codeforphilly.org (2026-05-18T14:23:00Z)

X people, Y projects, Z project-memberships, A project-updates,
B project-buzz, C tags, D tag-assignments.

Action: import.laddr.json
Source-Host: codeforphilly.org
Run-At: 2026-05-18T14:23:00Z
```

Author identity: the generic API user (`Code for Philly API <api@users.noreply.codeforphilly.org>`).

### Interactive development

The importer is built against the live `codeforphilly.org` from day one — no fixture SQL, no mock server. Iterate:

1. `curl https://codeforphilly.org/people?format=json | jq . | head` to discover the shape.
2. Adapt the translator and Zod input schema.
3. `--dry-run` to validate counts + surface warnings.
4. Real run against a scratch clone of `codeforphilly-data` checked out to a throwaway branch.
5. Inspect the commit; `git diff HEAD^` to verify the snapshot.
6. Re-run; verify the working tree is identical (idempotent when nothing has changed upstream).

### File / module changes

- **Delete**: `apps/api/scripts/import-laddr/mysqldump-parser.ts`, `apps/api/scripts/fixtures/laddr-fixture.sql`
- **Rewrite**: `apps/api/scripts/import-laddr.ts` (mysqldump → JSON-fetch entry)
- **New**: `apps/api/scripts/import-laddr/json-fetcher.ts` (HTTP + pagination + Zod-validated parsing)
- **Adapt**: `apps/api/scripts/import-laddr/translators.ts` (JSON-shape inputs)
- **Adapt**: `apps/api/scripts/import-laddr/importer.ts` (full-tree-replace mode + legacyId-keyed paths)
- **Drop dependency**: any mysqldump parser package from `apps/api/package.json` (use `npm uninstall`)

### Spec amendments (first commit on this branch)

`specs/behaviors/legacy-id-mapping.md` needs trimming:

- "Rule" para: drop `MySQL`; describe the source as `codeforphilly.org` JSON endpoints.
- "Applies to" bullet: replace "single big commit on the data repo" with "snapshot commits on `legacy-import`, merged into `main`".
- "When the importer runs" section: it's re-runnable now, not just three named occasions. Reframe to: "while the legacy site is the source of truth, the importer can be re-run any time to catch up `legacy-import` with the live data."

Implementation specifics (full-tree-replace, file naming, the `--dry-run` UX) stay out of the spec — those are in code and in this plan.

## Validation

- [ ] Live run against codeforphilly.org pulls all 7 resources, produces one commit on `legacy-import` (push succeeds).
- [ ] Re-running immediately produces no new commit (working tree identical to HEAD → exit 0 with "no changes").
- [ ] Modifying a single project on laddr (or simulating it via a `--source-host=<localmock>` against a captured-then-tweaked JSON fixture) and re-running produces a commit whose diff is exactly that one record.
- [ ] `--dry-run` produces a structured report without touching the data repo (no files written, no commits).
- [ ] `--limit=10` truncates each fetch.
- [ ] `legacy-import` merges cleanly into a fresh `main` where no legacy-paths have been edited.
- [ ] A simulated conflicting edit on `main` (manual test: change a record under `projects/<id>.toml` on main, re-run importer, attempt merge) surfaces as a normal git merge conflict.
- [ ] All filenames under each importer-owned directory match `<legacyId>.toml` (or the documented composite form).
- [ ] `Person.slackSamlNameId === Person.slug` for every imported person.
- [ ] Stage values are lowercase regardless of laddr's casing.
- [ ] No emails, password hashes, or other PII appear anywhere in the public repo (`grep -E '@[a-z0-9.-]+\.[a-z]+|\$2[aby]\$' -r <data-repo>` returns nothing).
- [ ] Tags split into `namespace`/`slug` correctly.
- [ ] Importer-untouched directories on `main` (e.g., `help-wanted-roles/`) survive a merge from `legacy-import` unchanged.
- [ ] Spec amendments to `legacy-id-mapping.md` land in the first commit on this branch.

## Risks / unknowns

- **Endpoint coverage.** Each of the 7 endpoints must exist on codeforphilly.org and return inferable JSON. Validate during dev; if `?format=json` is missing for any entity (likely candidates: project-memberships, project-buzz, tag-assignments — these may not have user-facing list pages), decide whether to add it on the laddr side (small PHP change), scrape an HTML index, or accept a private export for that table.
- **Pagination.** Large datasets (especially `project-updates`) may not return all rows in one response. Discover laddr's pagination scheme during dev (likely an `offset=` or `?page=` query string) and follow it.
- **Soft-deletes.** laddr's Emergence framework supports versioning; JSON responses may include archived rows. Decide policy during dev (filter at the importer, or carry an `archived` flag forward).
- **Slug-history continuity.** If laddr renames a slug between runs, the importer drops the old `<legacyId>.toml`'s slug field and writes the new one. Slug-history capture is the API's job at runtime (covered in [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md)) — the importer doesn't try to reconstruct it from snapshot diffs.
- **Merge strategy.** Once both branches have moved, the merge may need a deliberate strategy (e.g., always favor `legacy-import` for paths under importer-owned directories). Resolve at the first conflicting merge — over-specifying now is premature.
- **`?format=json` shape stability.** Emergence's JSON output is template-rendered, not a documented API. Schema may shift if anyone tweaks the templates upstream. Zod validation on input surfaces shape changes early.
- **Volume.** A full snapshot could be 10k+ records across 7 sheets; the resulting `git add -A` may be slow but is one-shot per run. No perf engineering needed unless a run takes >5min.

## Notes

(filled at closeout)

## Follow-ups

(filled at closeout)
