---
status: done
depends: [gitsheets-scripts, gitsheets-2.9]
specs:
  - specs/behaviors/storage.md
upstream-specs:
  - gitsheets:specs/api/repository.md
  - gitsheets:specs/api/transaction.md
pr: 252
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

- [x] prune-spam reads machine + human verdicts through ref-pinned sheets;
      no `transact` is used for reads
- [x] prune-spam on a fresh clone with only `origin/<branch>` commits the
      prune onto a newly created local branch, with no `update-ref` (test)
- [x] importer reads existing ids through a pinned store, and creates
      `legacy-import` through `transact` on first run (existing tests)
- [x] scrub-data writes configs and contracts with `tx.writeFile`; the
      snapshot is a parentless commit holding configs + contracts +
      records; a verification failure leaves no commit and no ref (tests)
- [x] Every remaining raw `git` call in `apps/api/scripts` is listed in
      Notes with its reason, and commented in code
- [x] `type-check` + `lint` + full test suite green

## Risks / unknowns

- Orphan `transact` refuses an existing branch, and same-seed re-runs hit
  exactly that case. Handled by the detached-commit path above.
- A pinned sheet resolves its ref once at open. That's fine for one-shot
  scripts.

## Notes

- **scrub-data couldn't go to one transaction.** The Approach planned a
  single `transact({ parent: null, branch })` that writes the configs with
  `tx.writeFile` and then upserts records. gitsheets 2.9 can't do that: a
  transaction's `tx.sheet()` loads its config from the transaction's
  parent commit, and from `HEAD` for an orphan (`#configTreeRef` in
  `sheet.js`). It never reads files staged with `tx.writeFile` in the same
  transaction. Every upsert failed with `config_missing`.
  - What shipped: `writeConfigRootCommit` is now one detached orphan
    `transact({ parent: null })` that writes each `.gitsheets/` file with
    `tx.writeFile`. The hash-object, temp index, write-tree and commit-tree
    plumbing is gone.
  - Records stage in a transaction on that hash, as before. The staged tree
    is still re-committed as the parentless snapshot with raw
    `commit-tree` + `update-ref`.
  - Using the `HEAD` fallback was rejected. It would read the target's
    previous snapshot configs, or need HEAD detached mid-run.
- **"No commit" on a failed scrub** means no referenced commit. The detached
  config-root and staging commits are left as unreferenced objects, as they
  were before.
- **Branch creation.** `transact({ parent, branch })` creates the branch only
  when it commits. A no-op transaction leaves a missing branch missing
  (probed against 2.9). So a dry-run or no-change prune on a fresh clone no
  longer creates the local branch. The importer's first run always commits.
- **Pinned reads.** A missing ref raises `RefError(ref_not_found)`;
  prune-spam rethrows its old `ref '<ref>' not found in <repo>` message
  (test). Pinned sheets resolve `HEAD` (via `rev-parse`), so
  `--evaluations-ref=HEAD` keeps working. The importer now reads ids at the
  commit it parents on, which on first run is `origin/<branch>` or
  `initialParent` (test).
- **Raw `git` left in `apps/api/scripts`:**
  - `scrub-data.ts`
    - `init`, `config`, `rev-parse --git-dir`: init the target. gitsheets
      has no init.
    - `rev-parse --absolute-git-dir` / `--is-bare-repository`: locate the
      target's git dir and detect a working tree.
    - `ls-tree -r --name-only <ref> .gitsheets/`: list config and contract
      files. gitsheets reads a blob by path but has no subtree listing.
    - `rev-parse HEAD^{tree}`: the no-change check. gitsheets doesn't expose
      a ref's tree.
    - `commit-tree`: re-commit the staged tree as an orphan (see above).
    - `update-ref`: point the snapshot branch at that commit. gitsheets
      can't point a branch at an existing commit, and same-seed re-runs
      overwrite.
    - `symbolic-ref HEAD`: the snapshot workflow pushes HEAD's branch.
      gitsheets never moves HEAD.
    - `tag -f`: gitsheets has no tag API.
    - `reset --hard`: sync a non-bare target's working tree. gitsheets is
      bare-style.
  - `check-sheet-configs.ts`: `init --bare`, `fetch --depth=1`, `ls-tree`,
    `show`, run against a throwaway clone of a remote ref. gitsheets has no
    fetch.
  - `backfill-laddr-events.ts`, `backfill-meetup-hack-nights.ts`: one
    create-only `update-ref` each, plus the same no-op `transact` read
    pattern. Outside this plan's three scripts and untested. See
    Follow-ups.
  - `prune-spam.ts` and `import-laddr/importer.ts` have no raw git left.

## Follow-ups

- Tracked as: gitsheets gap. `tx.sheet()` ignores configs staged with
  `tx.writeFile` in the same transaction, and an orphan transaction's
  sheets read configs from `HEAD`. Raise it upstream. When it's fixed,
  scrub-data's config root, staging transaction and `commit-tree` +
  `update-ref` collapse into one `transact({ parent: null, branch })`
  (with a detached fallback for a same-seed re-run).
- Tracked as: `backfill-laddr-events.ts` and
  `backfill-meetup-hack-nights.ts` still use the no-op-transact read and
  the create-only `update-ref`. Swap them to `openStore(repo, { ref })` and
  `transact({ parent, branch })` if they're run again.
- Tracked as: the open `gitsheets-scripts` follow-ups (old-vs-new prune on
  real data, scrub-data real-data blockers, credentials-importer `--ref`)
  are unchanged.
