---
status: done
depends: []
specs:
  - specs/behaviors/slug-handles.md
  - specs/behaviors/storage.md
pr: 199
---

# Plan: fix the slug-history sheet config and single-source sheet configs

## Scope

**Live bug.** The data repo's `.gitsheets/slug-history.toml` (on `empty`,
`fixture`, `published`) has `path = '${{ entityType }}/${{ slug }}'`, but
`SlugHistorySchema` has no `slug` — the field is `oldSlug`. Every upsert
throws `PathTemplateError path_render_failed`, which aborts the whole
transaction, so **every person slug rename, project slug rename, and
account-claim merge returns 500 in production**. `published` has zero
slug-history records. Origin: `apps/api/scripts/setup-dev-data.ts:39`.

Tests didn't catch it because they carry their own copies of the sheet
configs (`tests/helpers/test-full-repo.ts:30`, `internal-reload.test.ts:55`,
and others), which say `oldSlug`. The root problem is config duplication.

In:

- Fix `slug-history.toml` on every data-repo branch (`empty`, `fixture`,
  `published`, `legacy-import`) to `${{ entityType }}/${{ oldSlug }}`.
- Same bug, found by the new guard test: `help-wanted-roles.toml` templates
  on `${{ slug }}`, which roles don't have, so **creating a help-wanted role
  500s in production** too. Fix it to `${{ projectSlug }}/${{ id }}` per
  `storage.md`. Also align `help-wanted-interest.toml` (`personId` →
  `personSlug`, per spec). Both sheets have zero records, so there's
  nothing to migrate.
- `tag-assignments` differs from the spec, but production holds 7.7k
  records in its layout. Amend the spec to match rather than migrate.
- Tests load `.gitsheets/*.toml` from one canonical source — the data repo's
  `empty` branch, vendored or fetched — instead of inline copies.
- Delete `apps/api/scripts/setup-dev-data.ts` (stale: non-bare `git init`,
  which `store/public.ts` refuses; missing `blog-posts` and
  `person-evaluations`). Point local setup at `git clone --bare --branch
  fixture` as CLAUDE.md already describes.
- While touching `published`: re-normalize the two records that still carry
  integer underscores (`people/chris.toml`, `people/itskatnotcat.toml` — a
  plain-git merge of `legacy-import` on 2026-09-09 kept their
  1.4.1-serialized `githubUserId` lines).

Out: the attachment loss on rename — see
[`slug-rename-attachments`](slug-rename-attachments.md).

## Implements

- [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md) — renames
  record history so old slugs redirect.

## Approach

1. Data repo: one commit per branch editing `slug-history.toml` via the
   data repo's gitsheets tooling (read its `.claude/CLAUDE.md` first). The
   `published` push fires the hot-reload webhook; confirm the pod re-reads
   sheet configs on reload (today `swapPublic` re-opens the store, so it
   should). If not, restart the pod.
2. App repo: a `tests/helpers/sheet-configs.ts` that reads the canonical
   configs; replace every inline config map with it. Add a test that upserts
   one record into every sheet using the canonical configs — this is the
   check that would have caught the bug.
3. Delete `setup-dev-data.ts` and its npm script; update `.env.example` /
   docs if they reference it.

## Validation

- [x] `slug-history.toml` uses `oldSlug` on all four data-repo branches
- [x] `help-wanted-roles.toml` and `help-wanted-interest.toml` match
      `storage.md` on all four branches; a role can be created in production
- [x] A test fails when any vendored config's template names a field that
      isn't a required schema field or a declared write-injected path field
- [ ] Production: a person slug rename succeeds and writes a slug-history
      record; the old slug redirects
- [x] No inline `.gitsheets` config copies remain in `apps/api/tests`
      (grep `\[gitsheet\]`)
- [ ] New every-sheet upsert test passes against the canonical configs
- [x] `setup-dev-data.ts` gone; docs don't reference it
- [x] `published` has no integer-underscore literals
      (`git grep -E '= [0-9]+_[0-9]'` empty)
- [x] `type-check` + `lint` + full api suite green

## Risks / unknowns

- Whether hot reload picks up config changes. Verify before relying on it.
- Account-claim merges that failed on this bug left no partial state, since
  the transaction aborted, but users may have retried or given up. Check the
  API logs for `path_render_failed` to see how many people were affected.

## Notes

- Shipped in v0.6.0. The data-repo configs were pushed in lockstep, and the
  `published` push hot-reloaded production (fast-forwarded, rebuilt), so the
  500s stopped before the release.
- **Unchecked: a production slug rename.** No one has renamed a person or
  project since the fix (`published` has 0 slug-history records as of
  2026-10-14). The rename path runs against the real configs in the test
  suite, and every test repo now seeds from the vendored production configs.
- **Unchecked: the every-sheet upsert test.** Replaced by two stronger
  guards. `sheet-configs.test.ts` fails when any template field isn't a
  required schema field or a declared write-injected one; it caught the
  broken `help-wanted-roles` template. And later (`sheet-contracts`),
  gitsheets enforces each sheet's contract on every write.
- `tag-assignments` was documented in its production layout rather than
  migrated (7.7k records).
- The CI drift check needed a read-only deploy key: codeforphilly-data is
  private (`CFP_DATA_DEPLOY_KEY`).

## Follow-ups

- Tracked as: the first production slug rename. Confirm it writes a
  slug-history record and the old slug redirects.
