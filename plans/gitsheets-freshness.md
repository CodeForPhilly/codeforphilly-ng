---
status: done
depends: [gitsheets-2x-bump, slug-history-config]
specs:
  - specs/behaviors/storage.md
issues:
  - 150
pr: 200
---

# Plan: gitsheets 2.7 — retire the stale-Sheet workarounds

## Scope

The second half of #150, now unblocked. Upstream `gitsheets#184` (per-sheet
refresh) shipped via gitsheets PR #239 in **2.3.1** (2.3.0 never reached
npm). Bump `gitsheets` from `^2.2.0` to `^2.7.0`, then use the new APIs to
delete every workaround for the stale-`Sheet` cache, plus the shims and dead
code that 2.3+ made redundant.

In:

- Bump to `^2.7.0` (core-napi 0.1.1 → 0.5.0). Free win: 2.7 reads records
  in-core (gitsheets #295), so the markdown `blog-posts` sheet no longer
  spawns one process per record. Boot and hot reload get faster.
- **`swapPublic`** → `store.refresh()`.
- **`data-repo-lock`** → `repo.withLock()`, which shares the mutex
  `transact` uses. This **fixes a live race**: no write path takes
  `dataRepoLock` today, so the hot-reload webhook can race a `transact`,
  despite `storage.md` saying otherwise. The rebuild also runs *after* the
  lock is released, so a write that lands mid-`loadInMemoryState` can be
  clobbered by `swapInPlace`.
- **Raw `git cat-file` attachment streaming** → `sheet.getAttachment()`.
  It resolves the blob hash in-core with one spawn to stream, whereas
  `readBlobStream` uses 2–3 spawns. Use the blob hash as a strong `ETag`
  with immutable caching.
- **Reconcile's own `git push` calls** (`store/reconcile.ts` ~389, ~497) →
  `pushDaemon.notifyCommit(newCommit)`. Today a post-rebase push outside the
  daemon leaves it stuck in `non-fast-forward`.
- **Hot reload misses revocations**: `InMemoryRevocationStore` loads only
  `onReady`. Reload it as part of the rebuild.
- **Webhook `branch` override**: reject a `branch` other than
  `CFP_DATA_BRANCH`. `refresh()` reads `HEAD`, so reconciling a ref that
  `HEAD` doesn't point to would silently desync.
- Drop `stripNullish` (2.3 drops null/undefined keys natively and
  recursively, gitsheets #241) and the `asValidator` / `as PublicStore`
  casts (2.3 Standard Schema typing needs no cast, gitsheets #242).
- **Delete `store/sheet-indices.ts`**: 25 `defineIndex` definitions that
  nothing outside tests queries. Under auto-refresh, every transact
  invalidates index builds, so any future `findByIndex` would rescan after
  every write. Uniqueness checks already run against the in-memory maps.
- Write attachments from a Buffer (`setAttachments`), dropping the separate
  `writeBlob` step in `routes/people.ts` and the importer.

Out (separate plans):

- Incremental hot reload → [`incremental-reload`](incremental-reload.md).
- Scripts that bypass gitsheets → [`gitsheets-scripts`](gitsheets-scripts.md).
- Reconcile → upstream sync → [`gitsheets-sync`](gitsheets-sync.md).

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md): the hot-reload
  concurrency guarantee ("a webhook can't race a `transact`-driven write")
  becomes true, and the "caching limitation" section is retired.

## Approach

1. **Spec first** (own commit). In `storage.md`:
   - Rewrite "Direct gitsheets reads after a transact (caching limitation)":
     standing sheets auto-refresh after a committing transact, and
     out-of-process ref moves (reconcile) need `store.refresh()`.
   - Change the hot-reload **Concurrency** bullet: reconcile, rebuild and
     swap all run under the repo's transact mutex, and writes queue for the
     duration.
   - The webhook rejects a non-default `branch`.
   - Add an `ETag` to the attachment-serving rule.
2. **Bump**: `npm install gitsheets@^2.7.0 -w apps/api`. Commit the
   generated changes first.
3. **Lock**: delete `lib/data-repo-lock.ts` and the `dataRepoLock`
   decoration. Boot reconcile and the webhook run inside
   `fastify.publicRepo.withLock(...)`. The webhook wraps reconcile, refresh,
   rebuild and swap in **one** `withLock`.
   - `withLock` is not reentrant. Nothing inside it may call `transact`;
     verify reconcile only shells out to git.
   - Do the `git fetch` *outside* the lock so a slow network doesn't block
     writes, and rely on reconcile's existing CAS `update-ref`.
   - Writes queue behind the rebuild. Hot reloads are rare (external pushes
     to `published`), and 2.7 makes the load faster.
     [`incremental-reload`](incremental-reload.md) shrinks the window
     further.
4. **Refresh**: delete `Store.swapPublic`. `reloadInMemoryStateAndFts` runs
   `await store.public.refresh()`, then `loadInMemoryState`, then reloads
   revocations. Drop the re-open.
5. **Push**: replace reconcile's `git push` with `pushDaemon.notifyCommit`.
   At boot, the daemon's startup backlog already pushes commits that are
   ahead of the remote.
6. **Attachments**: use `sheet.getAttachment(path, name)` in
   `routes/attachments.ts`.
   - Map a missing attachment to 404, keep `validateKey`, set
     `ETag: "<blobHash>"`, and honor `If-None-Match` with a 304.
   - Attach a stream `'error'` handler.
   - This also fixes an empty blob being reported as 404.
7. **Shims and dead code**: delete `stripNullish`, `asValidator` and
   `sheet-indices.ts`. Pass the Zod schemas directly (`satisfies
   ValidatorMap`). Pass Buffers to `setAttachments`.
8. **Tests**: replace the `git show HEAD:…` / `swapPublic` fallbacks
   (`account-claim.test.ts`, `store.test.ts`, `moderation.test.ts`, …) with
   plain sheet reads or `sheet.get(path)` (gitsheets #296).

## Validation

- [x] `storage.md` updated in its own commit before the code changes
- [x] `gitsheets` resolves to ≥ 2.7.0; `@gitsheets/core-napi` loads in the
      Alpine (`linux-x64-musl`) image
- [x] grep clean: `data-repo-lock`, `swapPublic`, `stripNullish`,
      `asValidator`, `defineIndex`, `cat-file` in `routes/`, `git push` in
      `store/reconcile.ts`
- [x] New test: a write issued during a hot reload queues behind it and
      survives (no clobber)
- [x] New test: hot reload picks up a revocation added upstream
- [x] New test: webhook rejects a non-default `branch` with 400
- [x] Attachments: 200 with `ETag` for an existing key, 304 on
      `If-None-Match`, 404 for a missing key, correct empty-blob handling
- [x] A write of a record with cleared optional fields still produces no
      `null` keys on disk; no schema emits a `null` array element (2.3 throws
      on those)
- [ ] After a hot-reload rebase, the push daemon status is healthy (not
      `non-fast-forward`)
- [x] `type-check` + `lint` + full api suite green
- [ ] Sandbox: boot to ready and one hot-reload round trip succeed; record
      boot and reload timing vs. 2.2

## Risks / unknowns

- **Native addon jump** (core-napi 0.1 → 0.5). Mitigated by the sandbox
  check before live.
- **Behavior change**: standing sheets now see new commits. The revocation
  sweeper (`auth/middleware.ts`) reads a standing sheet. It gets fresher,
  which is intended, but watch its tests.
- **`refresh()` resolves `HEAD`.** Assert that the bare clone's `HEAD` is
  `refs/heads/$CFP_DATA_BRANCH` at boot.
- **Writes block for the length of a hot-reload rebuild.** That's
  acceptable at current reload frequency; `incremental-reload` is the fix if
  it isn't.

## Notes

- **Unchecked: daemon health after a rebase.** Covered by a unit test that
  reconcile hands rebased/ahead commits to the `push` option, and by reading
  gitsheets' daemon: a non-fast-forward isn't sticky, so the next
  `notifyCommit` gets a fresh attempt. A real post-rebase push wasn't
  exercised end to end.
- **Unchecked: sandbox boot + hot-reload round trip.** Needs a release. The
  Alpine image builds and `@gitsheets/core-napi` 0.5.0 loads in it (checked
  locally with `docker build`).
- The spec commit landed after the generated dependency-bump commit but
  before any code change.
- Found while testing: boot reconcile moved the branch after the store had
  opened its sheets, so a boot-time fast-forward served the old tree. Every
  pod start does a fresh clone, so this was rarely hit. Fixed here by
  refreshing whenever reconcile moves the branch; a test fails without it.
- Fetch runs outside the lock (via the new `fetchRemoteBranch`), and
  reconcile's ref moves stay CAS. Writes queue only for the rebuild.
- The hot-reload response now reports `noChanges` for `pushed-ahead` and
  `fetch-failed` too. Before, it rebuilt for any outcome other than `in-sync`.
- Attachments use `sheet.getAttachment` + `read()`, not `readBlobStream`: the
  in-core hash gives the ETag without a spawn, and a 304 reads no blob.
  2.7's `BlobHandle` has no stream, so a 200 buffers the blob. That's fine
  at avatar/hero-image sizes.

## Follow-ups

- Tracked as: sandbox validation of the next release (see Notes).
- Deferred to [`incremental-reload`](incremental-reload.md) — shrink the
  write-blocking window during hot reload.
