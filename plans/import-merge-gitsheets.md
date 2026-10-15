---
status: done
depends: [gitsheets-2.9]
specs: []
---

# Plan: the import merge uses gitsheets' sheet-aware merge

## Scope

The cutover runbook merged `legacy-import` into `published` with a plain
`git merge`, then bulk-resolved thousands of `deleted by us / modified by
them` conflicts with `git checkout --theirs`. A line-wise merge of TOML
records left records in a mix of serializations no gitsheets version
writes. gitsheets 2.8 shipped a record-level merge (gitsheets#307). This
switches the runbook step to `gitsheets merge --prefer theirs`, which runs
on the bare clone, adds a `--dry-run` preview, and follows with a
`contracts verify`. It's an operator-doc change only; no app code and no
spec behavior changes.

## Implements

- `docs/operations/cutover.md` step 5 (operator runbook; not a spec).

## Validation

- [x] Dry-run merge of `legacy-import` into a copy of `published` runs on
      real data (6s; 0 field merges, since 09-08's import is already merged)
- [x] `contracts verify --ref <branch>` works as the runbook uses it
- [x] `--prefer theirs` semantics match the old policy: a delete/modify
      conflict takes the import's record (gitsheets specs/behaviors/merge.md)

## Notes

- The merge doesn't validate contracts, so the runbook verifies after it.
  Rename/directory conflicts are always reported and stop the merge.
- The first real exercise of `--prefer theirs` on conflicts comes with the
  next fresh laddr import; this repo has no import scheduled.

## Follow-ups

None.
