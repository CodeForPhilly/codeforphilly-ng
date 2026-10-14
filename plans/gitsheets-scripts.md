---
status: done
depends: [gitsheets-freshness]
specs:
  - specs/behaviors/storage.md
  - specs/behaviors/spam-exclusion.md
awaits:
  - "https://github.com/JarvusInnovations/gitsheets/issues/303 — ref-scoped read-only sheets — cleaner than the no-op-transact read trick"
  - "https://github.com/JarvusInnovations/gitsheets/issues/305 — public tx.writeFile / orphan commits — needed for scrub-data's config writes"
pr: 204
---

# Plan: route operator scripts through gitsheets

## Scope

Three operator scripts read and write the data repo with raw git plumbing
and hand-rolled TOML instead of gitsheets. They have bugs that gitsheets
would have prevented.

- **`scripts/prune-spam.ts`** (~170–300, ~420–443) reads records at another
  ref with `ls-tree` and `cat-file --batch`, parses TOML with regexes, and
  aims commits with `rev-parse`, `update-ref` and `symbolic-ref`.
  - **Bug:** it slices utf8 strings by blob byte size, so multibyte LLM
    `reasoning` text misparses.
  - **Bug:** `hashPathPairs.find` is O(n²) over roughly 54k records.
- **`scripts/import-laddr/importer.ts`** (~664–717) moves `HEAD` and refs by
  hand to aim its snapshot commit at `legacy-import`.
- **`scripts/scrub-data.ts`** (~237–675) has its own `toToml`,
  `parseFlatToml` and path-template resolver.
  - **Bug:** a missing field renders as `''`, so record paths collide.
  - **Bug:** it writes `blog-posts` as `.toml` instead of the markdown
    format.
  - **Bug:** attachments are silently dropped.
  - It also builds commits from a working tree and `commit-tree`.

In:

- Reads at a ref: use a no-op `repo.transact({ parent: ref }, tx =>
  tx.sheet(...).queryAll())`, which commits nothing, until upstream ships
  ref-scoped sheets.
- Writes to a branch: use `transact({ parent, branch })` and drop the manual
  ref plumbing.
- Port scrub-data's record writes to sheet upserts, so it gets canonical
  TOML, correct paths, the markdown format and attachments. Config writes
  and the orphan root commit stay on raw git until upstream exposes them.

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md): every write to the
  data repo goes through gitsheets.
- [behaviors/spam-exclusion.md](../specs/behaviors/spam-exclusion.md):
  prune semantics are unchanged.

## Approach

Port one script per commit, prune-spam first because it has the live bugs.
Each port keeps the existing CLI flags. Diff the output against the old
script on a copy of `published` before deleting the old code path.

## Validation

- [ ] prune-spam: identical prune set on a copy of `published` vs. the old
      script; a record with multibyte `reasoning` parses correctly; runtime
      on 54k records is not quadratic
- [ ] importer: snapshot commit lands on `legacy-import` with no manual
      `update-ref` / `symbolic-ref`
- [x] scrub-data: `blog-posts` written as markdown, attachments preserved,
      no path collisions on records with missing optional fields
- [x] No hand-rolled TOML parse/stringify left in `apps/api/scripts`
- [x] `type-check` + `lint` + full api suite green

## Risks / unknowns

- The no-op-transact read is a trick, not an API. Swap it out when
  ref-scoped sheets land upstream.

## Notes

- **prune-spam validation left unchecked.** The multibyte and scale halves
  were verified; the "identical prune set on a copy of `published`" half
  was not run, because this change was built without touching the real
  data or private evaluations repos. The fixture comparison stands in for
  it: the new `tests/prune-spam.test.ts` aggregation/cascade case produced
  the same summary counts on the old script (only the HEAD assertion
  differed). On a synthetic 54k-record evaluations repo the old reader took
  145s and saw 29,454 of 54,000 people (every multibyte `reasoning` record
  desynced the `cat-file` stream); the new one takes ~2s and sees all
  54,000. Run both against a copy of `published` before the next
  production prune to close this box.
- **The no-op-transact read.** `repo.transact({ parent: <hash> })` with no
  mutations finalizes to `commitHash: null` and moves no ref (checked
  against 2.7). Parent must be a resolved hash: the core rejects `HEAD` as
  a parent name. The trick lives in `aggregateVerdicts` (prune-spam) and
  `collectExistingIdsAt` (importer).
- **importer validation left unchecked.** The snapshot commit itself lands
  on `legacy-import` through `transact({ parent, branch })` with no
  `symbolic-ref` (tested), but the first run still creates the branch with
  one create-only `update-ref` (next note). Closes when gitsheets can
  create a branch from `transact`.
- **`transact({ branch })` only advances an existing branch.** It is a
  compare-and-swap against `parent`; naming a branch that doesn't exist
  fails with `commit_failed`. So prune-spam and the importer still create
  the local branch on a fresh clone with one create-only
  `git update-ref <ref> <hash> ''`. No `symbolic-ref` is left in either.
- **HEAD no longer moves.** Both scripts used to leave the data repo's HEAD
  on their branch, which the credentials importer (reads HEAD) leaned on
  in the cutover runbook. `docs/operations/cutover.md` now says to aim
  HEAD at `published` explicitly.
- **scrub-data raw git that remains** (both commented in code): the
  config-only root commit (`hash-object` / `mktree` / `commit-tree`),
  because 2.7's `tx.writeFile` is internal; and the final orphan commit +
  `update-ref` / `symbolic-ref HEAD` / `tag`, because gitsheets can't write
  a parentless commit and the snapshot workflow pushes and tags HEAD.
  Records are staged in a gitsheets transaction on a hash parent, then
  that tree is re-committed as the orphan.
- **scrub-data behavior changes beyond the plan's three bugs.** Array
  fields (e.g. `flags`, tags) were silently dropped by the old `toToml`;
  they're kept now. A missing path-template field now fails the run,
  naming the sheet and record, instead of collapsing records. Person
  avatars are still dropped (photos of real people), but project and buzz
  attachments and their `featuredImageKey` / `imageKey` now follow.
  Verification also scans `.md` records and runs on the serialized
  records before any target ref moves, so a failed run leaves the target
  untouched rather than wiped.
- **`awaits` left in place.** Neither upstream feature has shipped; this
  plan worked around both (no-op transact for reads, raw git for configs
  and the orphan commit). See Follow-ups for what changes when they land.

## Follow-ups

- Tracked as: the `awaits` entry for ref-scoped read-only sheets. When it
  ships, replace the no-op transacts in `aggregateVerdicts`
  (`apps/api/scripts/prune-spam.ts`) and `collectExistingIdsAt`
  (`apps/api/scripts/import-laddr/importer.ts`) with a sheet opened at the
  ref.
- Tracked as: the `awaits` entry for public `tx.writeFile` / orphan
  commits. When it ships, `writeConfigRootCommit` and the step-9 orphan
  commit in `apps/api/scripts/scrub-data.ts` move into one transaction. A
  gitsheets "create branch" option on `transact` would also remove the
  create-only `update-ref` in prune-spam's and the importer's
  `resolveTargetBranch`.
- Tracked as: run old vs. new prune-spam `--dry-run` against a copy of
  `published` + the private evaluations repo (the unchecked validation
  box above).
- Tracked as: scrub-data can't pass verification on real data as-is, for
  reasons this plan didn't touch. It rewrites person slugs only in
  `people` and in `@mentions`, so `personSlug` in `project-memberships`
  and `person-evaluations` (and in their paths) still carries real slugs. And `.github/workflows/snapshot.yml` clones the
  data repo's nonexistent `main` branch. Both need a spec'd fix before the
  weekly snapshot can run.
- Tracked as: `import-laddr-credentials` reads the data repo's HEAD; a
  `--ref` flag would retire the runbook workaround added here.
