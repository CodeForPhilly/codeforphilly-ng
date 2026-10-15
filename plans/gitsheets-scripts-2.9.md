---
status: planned
depends: [gitsheets-scripts, gitsheets-2.9]
specs:
  - specs/behaviors/storage.md
upstream-specs:
  - gitsheets:specs/api/repository.md
  - gitsheets:specs/api/transaction.md
---

# Plan: retire the scripts' git workarounds on gitsheets 2.9

## Scope

[`gitsheets-scripts`](gitsheets-scripts.md) routed the operator scripts
through gitsheets but left three workarounds, each waiting on an upstream
API. gitsheets 2.9 (adopted in [`gitsheets-2.9`](gitsheets-2.9.md)) ships
all of them:

- **#303 ref-pinned sheets.** `repo.openSheet(name, { ref })`,
  `repo.openSheets({ ref })` and `openStore(repo, { ref })` return
  read-only sheets bound to a ref. They replace the no-op
  `transact({ parent })` read trick in prune-spam's `aggregateVerdicts` and
  the importer's `collectExistingIdsAt`.
- **#305 raw files and orphan commits.** `tx.writeFile` / `tx.deleteFile`
  are public. `transact({ parent: null, branch })` writes a parentless root
  commit and creates the branch, and `transact({ parent, branch })` creates
  a missing branch.
  - In prune-spam and the importer, this retires the create-only
    `git update-ref` in `resolveTargetBranch`.
  - In scrub-data, it retires `writeConfigRootCommit` (`hash-object`,
    temp index, `write-tree`, `commit-tree`) and the step-9 orphan
    `commit-tree` + `update-ref`.

In: those swaps, with every CLI flag and every report line unchanged.

Out: the open Follow-ups of `gitsheets-scripts` that this doesn't touch
(old-vs-new prune comparison on real data, the scrub-data real-data
blockers, a `--ref` for `import-laddr-credentials`).

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md): every write to the
  data repo goes through gitsheets. Raw git stays only for what gitsheets
  has no API for: repo init, HEAD, tags, listing a subtree, and
  working-tree checkout.

## Approach

One commit per script.

- **prune-spam.**
  - `aggregateVerdicts` opens `person-evaluations` with
    `openSheet(..., { ref })`. A missing ref still fails with the same
    message, and a missing sheet config still contributes nothing.
  - `resolveTargetBranch` returns the commit parent instead of creating
    the ref: the local branch if it exists, else `origin/<branch>`'s
    commit. `transact({ parent, branch })` creates the branch when the
    prune commits.
- **importer.**
  - `collectExistingIdsAt` reads through
    `openStore(repo, { ref, validators })`.
  - `resolveTargetBranch` changes the same way as prune-spam's, falling
    back to `initialParent`.
- **scrub-data.**
  - One transaction stages the whole snapshot: `tx.writeFile` for every
    `.gitsheets/` file (configs plus contracts), then the record upserts
    and attachments.
  - Count parity and the PII verification run inside the handler, so a
    failure throws before anything commits and no ref moves.
  - Normal case (snapshot branch absent): `transact({ parent: null,
    branch })` is the orphan commit and creates the branch.
  - Re-run case (branch already exists for the seed): a detached orphan
    commit. If its tree matches HEAD's, that's the no-op it was before.
    Otherwise the branch is force-moved with `update-ref`, because
    gitsheets can't repoint an existing branch at an unrelated commit.
  - `symbolic-ref HEAD`, the tag, and the working-tree reset stay on raw
    git (no gitsheets API).

## Validation

- [ ] prune-spam reads machine + human verdicts through ref-pinned sheets;
      no `transact` is used for reads
- [ ] prune-spam on a fresh clone with only `origin/<branch>` commits the
      prune onto a newly created local branch, with no `update-ref` (test)
- [ ] importer reads existing ids through a pinned store, and creates
      `legacy-import` through `transact` on first run (existing tests)
- [ ] scrub-data writes configs and contracts with `tx.writeFile`; the
      snapshot is a parentless commit holding configs + contracts +
      records; a verification failure leaves no commit and no ref (tests)
- [ ] Every remaining raw `git` call in `apps/api/scripts` is listed in
      Notes with its reason, and commented in code
- [ ] `type-check` + `lint` + full test suite green

## Risks / unknowns

- Orphan `transact` refuses an existing branch, and same-seed re-runs hit
  exactly that case. Handled by the detached-commit path above.
- A pinned sheet resolves its ref once at open. That's fine for one-shot
  scripts.

## Notes

## Follow-ups
