---
status: planned
depends: [gitsheets-freshness]
specs:
  - specs/behaviors/storage.md
  - specs/behaviors/spam-exclusion.md
awaits:
  - "JarvusInnovations/gitsheets — ref-scoped read-only sheets (issue TBD) — cleaner than the no-op-transact read trick"
  - "JarvusInnovations/gitsheets — public tx.writeFile / orphan commits (issue TBD) — needed for scrub-data's config writes"
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
- [ ] scrub-data: `blog-posts` written as markdown, attachments preserved,
      no path collisions on records with missing optional fields
- [ ] No hand-rolled TOML parse/stringify left in `apps/api/scripts`
- [ ] `type-check` + `lint` + full api suite green

## Risks / unknowns

- The no-op-transact read is a trick, not an API. Swap it out when
  ref-scoped sheets land upstream.

## Notes

## Follow-ups
