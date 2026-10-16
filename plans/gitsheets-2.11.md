---
status: done
depends: [gitsheets-sync, gitsheets-scripts-2.9]
specs:
  - specs/behaviors/storage.md
upstream-specs:
  - gitsheets:specs/api/repository.md
  - gitsheets:specs/api/transaction.md
  - gitsheets:specs/behaviors/push-sync.md
pr:
---

# Plan: adopt gitsheets 2.11 and retire the reconcile side handle

## Scope

gitsheets 2.11 ships the APIs that the last workarounds in reconcile and
scrub-data were waiting on:

- **`repo.sync({ afterMove })`.** The hook is awaited under the write lock
  after the branch moved and live sheets were rebound, before the push
  daemon hand-off. The API's reconcile no longer needs a second `openRepo`
  handle synced inside the serving handle's `withLock`.
- **`repo.fetch({ remote, branch })`.** Returns `{ ok, … }` and never throws
  on network or auth failures. It replaces the raw `git fetch` in
  `store/reconcile.ts` and pairs with `sync({ fetch: false })`.
- **`tx.sheet()` reads configs from the transaction's own tree.** Configs
  staged with `tx.writeFile` before a sheet's first use now apply. That
  closes the `gitsheets-scripts-2.9` follow-up: scrub-data's config root,
  staging transaction and `commit-tree` re-commit collapse into one
  `transact({ parent: null, branch })`.
- **`repo.tag(name, target, { force })` and `repo.listTree(ref, path)`.**
  These replace `git tag -f` and `ls-tree`.

In: the dependency bump, the reconcile rewrite onto the serving handle,
the scrub-data collapse, `check-sheet-configs` and the reload config-diff
moved onto `fetch`/`listTree` where they fit, and stale comments removed.

Out: `backfill-*` scripts (still the open `gitsheets-scripts-2.9`
follow-up), any behavior change to the webhook, boot or snapshot outputs.

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md) → Hot reload,
  Concurrency: one critical section of the write lock covers the ref move,
  the store refresh and the rebuild. It is now `repo.sync()`'s `afterMove`.
- [behaviors/storage.md](../specs/behaviors/storage.md): every write to the
  data repo goes through gitsheets; raw git stays only where gitsheets has
  no API.

## Approach

1. `npm install gitsheets@^2.11.0 -w apps/api` as its own commit.
2. Spec wording: the Concurrency bullet names `repo.withLock`. Point it at
   `sync`'s `afterMove`.
3. `store/reconcile.ts` takes the serving `Repository`. It fetches with
   `repo.fetch` outside the lock, then calls `repo.sync({ fetch: false,
   onConflict: 'preserve-branch', conflictBranchPrefix: 'conflicts/',
   committer, afterMove })`. `plugins/reconcile.ts` drops its `withLock`
   and passes an `afterMove` that refreshes the public store and runs
   `onMoved`. `sync` notifies the repository's running push daemon itself,
   so the plugin stops passing a `push` hand-off.
4. `scrub-data.ts`: one transaction stages `.gitsheets/` with
   `tx.writeFile`, upserts records, and runs count parity and PII
   verification inside the handler. If the snapshot branch is absent it
   commits with `parent: null, branch`. A same-seed re-run commits detached
   and compares trees: an equal tree is a no-op, otherwise it force-moves
   the branch. The tag goes through `repo.tag(…, { force: true })` and
   config listing through `repo.listTree`.
5. `check-sheet-configs.ts`: `repo.fetch` + `listTree` + `readBlob` against
   a throwaway bare repo, if it fits.

## Validation

- [x] `gitsheets@^2.11.0` in `apps/api/package.json`;
      `@gitsheets/core-napi-linux-x64-musl` present in `package-lock.json`
- [x] Reconcile runs through the serving handle; no second `openRepo` and
      no surrounding `withLock`
- [x] `internal-reload.test.ts` "serializes a write issued during a hot
      reload; neither change is lost" and "holds the write lock from the
      ref move through the rebuild" pass unchanged
- [x] Outcome vocabulary, webhook response shape, conflict branch naming and
      boot behavior unchanged (existing tests)
- [x] scrub-data writes the snapshot in one orphan transaction; snapshot
      tests (parentless commit, HEAD + tag, same-seed no-op, failure leaves
      no ref) pass
- [x] Every remaining raw `git` call in `apps/api/src` and `apps/api/scripts`
      is listed in Notes with its reason
- [x] `type-check` + `lint` + full test suite green

## Risks / unknowns

- An orphan `transact` still refuses an existing branch, so a same-seed
  re-run needs the detached path plus a raw branch move.
- `afterMove` runs inside the lock: anything in the rebuild that takes the
  lock or transacts would be `lock_held`. The rebuild already ran inside
  `withLock`, so it has the same constraint as before.

## Notes

- **Why `afterMove` keeps the guarantee.** `sync` acquires the serving
  repository's write lock — the FIFO mutex every `transact` queues on —
  moves the ref, rebinds live sheets, and awaits `afterMove` before
  releasing it. The store refresh and the in-memory rebuild run in that
  hook, so a write queued during a reload acquires the lock only after the
  rebuild finished. That is the same critical section the old
  `withLock` around a side-handle sync gave, now on one handle. Both
  `internal-reload.test.ts` lock tests pass with no change to the file;
  the lock-holding test's mechanism (`publicRepo.withLock` hold +
  `onMoved`) never referenced the side handle.
- **A throw in `afterMove`** propagates after the lock is released with the
  ref moved, same as a throw inside the old `withLock`. The webhook still
  500s with "pod restart required".
- **Push hand-off.** `sync` notifies the repository's running push daemon
  of an ahead/replayed tip itself, so the plugin no longer passes `push`.
  Passing it as well would notify twice. `reconcileDataRepo` keeps the
  option for a repository without a daemon (the unit tests use it). At
  boot there's no daemon yet, and its startup backlog pushes, as before.
- **Fetch-failed** now reports the branch's commit (`refs/heads/<branch>`)
  rather than `HEAD`'s; the app's HEAD always points at that branch.
- **reload.ts.** The incremental reload's config-change guard used raw
  `git rev-parse <commit>:.gitsheets`. It now compares
  `repo.listTree(commit, '.gitsheets')` listings (each entry carries its
  hash, so equal listings mean equal trees). That was the last raw git in
  `apps/api/src`.
- **scrub-data re-run.** An orphan `transact` still refuses an existing
  branch. A same-seed re-run commits detached, compares root `listTree`
  listings with the branch (replacing `rev-parse HEAD^{tree}`), and returns
  no commit when they match. When they differ it force-moves the branch
  with `update-ref`. New test covers the changed-content re-run. The
  commit date is now gitsheets' clock rather than the message timestamp
  fed through `GIT_*_DATE`; the message still carries the timestamp.
- **check-sheet-configs** loses `--depth=1`: `repo.fetch` has no depth
  option. The `empty` branch holds only `.gitsheets/`, so the full fetch
  is small. Verified by hand against a local bare remote (match → exit 0,
  drift → exit 1, bad remote → throws).
- **Raw `git` left:**
  - `apps/api/src`: none.
  - `scrub-data.ts`
    - `rev-parse --git-dir`, `init`, `config`: init the target. gitsheets
      has no init.
    - `rev-parse --absolute-git-dir` / `--is-bare-repository`: locate a
      non-bare target's git dir and detect a working tree.
    - `update-ref`: same-seed re-run with changed content. gitsheets can't
      repoint an existing branch at an unrelated commit.
    - `symbolic-ref HEAD`: the snapshot workflow pushes HEAD's branch, and
      gitsheets never moves HEAD.
    - `reset --hard`: sync a non-bare target's working tree. gitsheets is
      bare-style.
  - `check-sheet-configs.ts`: `init --bare` (no init API) and
    `remote add` (`repo.fetch` takes a remote name, not a URL).
  - `backfill-laddr-events.ts`, `backfill-meetup-hack-nights.ts`: one
    create-only `update-ref` each. Unchanged; see Follow-ups.

## Follow-ups

- Tracked as: the `gitsheets-scripts-2.9` follow-up for the two
  `backfill-*` scripts (no-op-transact reads and create-only `update-ref`)
  stays open.
- Tracked as: gitsheets gap. A way to point an existing branch at a given
  commit (or an orphan transact that may replace a branch) would retire
  scrub-data's last `update-ref`. A `repo.init` would retire the init
  plumbing in scrub-data and check-sheet-configs.
