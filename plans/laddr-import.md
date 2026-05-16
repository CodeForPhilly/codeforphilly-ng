---
status: done
depends: [storage-foundation]
specs:
  - specs/behaviors/legacy-id-mapping.md
  - specs/data-model.md
issues: []
pr: 24
---

# Plan: Laddr importer

## Scope

A one-shot migration script that reads a mysqldump from the production laddr database and writes records into both the new public gitsheets repo and the private bucket. Idempotent on `legacyId`. Preserves slugs (so every laddr URL continues to work post-cutover). Seeds `slackSamlNameId` from `Username` so Slack identities stay continuous.

Out of scope: production cutover orchestration (that's [`cutover-prep`](cutover-prep.md)); the public-snapshot scrub ([`public-snapshot-scrub`](public-snapshot-scrub.md)); the runtime API. This plan delivers a script you can run against a fresh repo + empty bucket and end up with a usable system.

## Implements

- [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md) — `legacyId` columns + the unique partial-index discipline, the URL-redirect contract that lives in the web layer
- [data-model.md](../specs/data-model.md) — every migrated entity's field mapping from laddr to v1
- [data-model.md naming map](../specs/data-model.md#naming-map-laddr--rewrite) — confirms exactly which laddr columns go where

## Approach

### Script entry point

`apps/api/scripts/import-laddr.ts` — invoked from the CLI:

```bash
npm run -w apps/api script:import-laddr -- \
  --sql=./scratch/laddr-2026-05-15.sql \
  --data-repo=./codeforphilly-data \
  --private-store=./scratch/private-storage \
  [--dry-run] [--verbose] [--limit=N]
```

`--dry-run` prints what would happen without writing. `--limit=N` truncates per-table imports (useful for staging tests).

### Reading mysqldump

Use a streaming mysqldump parser (`mysqldump-to-postgres` adapted, or `mysql-parser` for direct mysqldump → JS objects). Don't try to load whole SQL files into memory — laddr's DB is large.

Strategy: parse out the `INSERT INTO <table>` blocks, deserialize the row tuples, yield rows lazily per table.

### Order of imports

```
1. tags                       (no FKs)
2. people                     (creates Persons; PrivateProfiles for emails; LegacyPasswordCredentials)
3. projects                   (refs Person.maintainerId; needs people loaded first)
4. project-memberships        (refs Project + Person)
5. project-updates            (refs Project + Person)
6. project-buzz               (refs Project + Person)
7. tag-assignments            (refs Tag + (Project|Person|HelpWantedRole))
                              (HelpWantedRoles aren't in laddr — new in v1; no imports)
```

Each table's import:

1. Iterate rows
2. For each row, build the v1 record per [data-model.md](../specs/data-model.md)'s naming map
3. Validate via Zod (`PersonSchema.parse(...)` etc.)
4. Generate UUIDv7 for `id`; preserve `legacyId` from the laddr ID
5. For Persons: also build the `PrivateProfile` (email + verifiedAt) + `LegacyPasswordCredential` (hash) records for the private store; and populate `Person.slackSamlNameId = slug`
6. Upsert into the public gitsheets repo OR the private store

### Idempotence

The script can be re-run safely. Each upsert checks `byLegacyId.<entity>` first; if a record with that legacyId exists, update it instead of inserting (matching gitsheets v1.0's `Sheet.upsert` semantics, but explicit because we're tracking the new UUID stability).

For private records: same — keyed by `personId` which is stable across re-imports because we resolve via `legacyId`.

### Single big commit

Per [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md), the public side ships as **one big commit** message:

```
import: from laddr mysqldump 2026-05-15

X people, Y projects, Z project-memberships, A project-updates,
B project-buzz, C tags, D tag-assignments imported.

Action: import.laddr
Source-Dump: <sha256 of the mysqldump file>
Run-At: 2026-05-15T12:34:56Z
```

The transaction wraps every public-side insertion. Private-side PUTs land at the end, after the public commit succeeds, in batches per private sheet (one `profiles.jsonl` PUT, one `legacy-passwords.jsonl` PUT).

Author identity: the generic API user (`Code for Philly API <api@users.noreply.codeforphilly.org>`) per [behaviors/storage.md](../specs/behaviors/storage.md).

### Slug uniqueness handling

Laddr slugs are mostly unique already, but the rewrite tightens validation. Audit during the dry-run:

- Slugs that don't match the new regex → log + (option A) silently slugify-then-dedupe with `-2`, (option B) error and require fixing in laddr first
- Decide at dry-run time; document in this plan's Notes

### Stage value normalization

laddr `Stage` is TitleCase (`Commenting`, `Prototyping`, etc.). v1 is lowercase (`commenting`, `prototyping`, ...). Translate during import.

### `member_checkins` etc

Tables we're dropping per [deferred.md](../specs/deferred.md): skip entirely. The import script doesn't read them.

### Dry-run report

`--dry-run` produces a JSON report:

```json
{
  "people": { "input": 1240, "valid": 1235, "skipped": 5, "errors": [...] },
  "projects": { ... },
  ...
  "warnings": [
    "Person legacyId=1234 has slug 'with weird chars'; will be slugified to 'with-weird-chars'",
    ...
  ]
}
```

Staff review the report before the real run.

## Validation

- [x] Run against a small fixture mysqldump → produces the expected records in the public repo + private store
- [x] Re-run against the same dump → no-op (idempotent; byLegacyId lookups hit existing rows)
- [x] Run with `--limit=10` → only the first 10 of each table imported
- [x] Dry-run produces a complete JSON report with no DB writes
- [x] `Person.slackSamlNameId` populated correctly for every Person; matches their `slug`
- [x] Stage values translated (TitleCase → lowercase)
- [x] `Person.email`, `LegacyPasswordCredential.passwordHash` land in the private store, not the public repo (grep the public repo for any email pattern → zero hits)
- [x] Tag handles like `topic.transit` split correctly into `namespace='topic', slug='transit'`
- [x] `tag_items.ContextClass` → `taggableType` mapping correct
- [ ] All laddr slugs are accessible via `/projects/:slug` and `/members/:slug` after the import (verified via API test on a sample of 100 random records)
- [x] Drop-tables (member_checkins, blog_posts, etc.) are skipped without error

## Risks / unknowns

- **Encoding gotchas.** laddr's MySQL might be utf8mb3, the new system is utf8mb4-equivalent (Node strings are unicode). Emoji and 4-byte chars in laddr text may round-trip oddly. Verify on a sample.
- **Password hash algorithm.** Probably bcrypt (Emergence-era PHP standard). Verify by inspecting the first few hashes. If sha512crypt or something exotic, install a verifier.
- **Slugs that don't match the new regex.** Need a decision pre-import (silently slugify vs. error). Default I'd go with: silently slugify-and-dedupe, log warnings, let staff review.
- **Time of run.** The single big commit is large — could be hundreds of thousands of file writes if laddr has lots of project-updates. May need to chunk by entity type into multiple commits to keep individual commits reviewable. Decide during dry-run; could end up with one commit per entity type (7 commits total).

## Notes

- **Per-entity commits over single big commit.** Shipped as 7 commits (one per sheet, in FK-order). Each is reviewable on its own — the "could be hundreds of thousands of file writes" risk in the original plan landed on the chunked side.
- **Slug-collision policy: silently slugify-and-dedupe with `-N` suffix.** That was the plan's "default I'd go with" choice. Warnings emitted for every normalization or dedupe so staff can review them in the dry-run report before the real run.
- **`--limit=10` criterion verified with `--limit=1` in the test.** The CLI parameter is the same; only the test value differs.
- **`/projects/:slug` and `/members/:slug` reachability** stays unchecked at merge time — those routes are owned by `read-api` and aren't built yet. The slugs themselves are committed (verified by the import-laddr test) and the gitsheets path templates match the API's expected lookup shape, so reachability will close out once `read-api` lands. Tracked in Follow-ups.
- **Idempotence for memberships + tag-assignments** uses composite-path presence in the data repo's git tree, not `legacyId` (those sheets don't carry one). This means re-running after a manual edit that changes path-defining fields would no-op rather than re-import; staff should reset the repo before a re-run if they want a forced re-import.
- **LegacyPasswordCredential writes** reach past the `PrivateStoreTx` runtime interface (which only exposes profile mutations + legacy-password *deletes* — the runtime drains them, never adds). Import flushes via a typed cast onto the BasePrivateStore's internal `legacyPasswords` Map. Documented at the call site; narrow blast radius (one-shot migration only).
- **Password-hash algorithm verification deferred** — the fixture uses synthetic `$2y$10$...` (bcrypt) strings. Real production hashes need a one-time inspection before cutover; the account-claim endpoint (separate plan) will verify against them.

## Follow-ups

- Tracked as: `read-api` / `web-routing` to close out the last validation criterion (laddr slugs reachable via `/projects/:slug` and `/members/:slug`) once those routes exist.
- Issue [#25](https://github.com/CodeForPhilly/codeforphilly-ng/issues/25) — verify production-dump password-hash format (bcrypt vs sha512crypt vs Emergence-specific) before staging cutover.
- Issue [#26](https://github.com/CodeForPhilly/codeforphilly-ng/issues/26) — `--limit=N` tally edge case: `input` counts pre-limit rows (intentional, so dry-run reports reflect dump size) but `imported + skipped + errors` < `input` when limited, which may surprise; document in the script's --help once we have one.
