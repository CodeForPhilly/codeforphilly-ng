---
status: in-progress
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

- [ ] `gitsheets@^2.11.0` in `apps/api/package.json`;
      `@gitsheets/core-napi-linux-x64-musl` present in `package-lock.json`
- [ ] Reconcile runs through the serving handle; no second `openRepo` and
      no surrounding `withLock`
- [ ] `internal-reload.test.ts` "serializes a write issued during a hot
      reload; neither change is lost" and "holds the write lock from the
      ref move through the rebuild" pass unchanged
- [ ] Outcome vocabulary, webhook response shape, conflict branch naming and
      boot behavior unchanged (existing tests)
- [ ] scrub-data writes the snapshot in one orphan transaction; snapshot
      tests (parentless commit, HEAD + tag, same-seed no-op, failure leaves
      no ref) pass
- [ ] Every remaining raw `git` call in `apps/api/src` and `apps/api/scripts`
      is listed in Notes with its reason
- [ ] `type-check` + `lint` + full test suite green

## Risks / unknowns

- An orphan `transact` still refuses an existing branch, so a same-seed
  re-run needs the detached path plus a raw branch move.
- `afterMove` runs inside the lock: anything in the rebuild that takes the
  lock or transacts would be `lock_held`. The rebuild already ran inside
  `withLock`, so it has the same constraint as before.

## Notes

## Follow-ups
