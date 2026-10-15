---
status: done
depends: [gitsheets-freshness]
specs:
  - specs/behaviors/storage.md
pr:
---

# Plan: replace hand-rolled reconcile with upstream `repo.sync()`

## Scope

`store/reconcile.ts` implements its own fetch, then fast-forward, replay or
escape-hatch, using `merge-tree --write-tree`, `commit-tree` and a CAS
`update-ref`. `routes/internal.ts` adds its own `rev-parse` and
`merge-base --is-ancestor` pre-check. That is general-purpose sync logic
that every gitsheets consumer with a push daemon and an external writer
needs. gitsheets is push-only today by design.

Upstream ask: an opt-in `repo.sync({ remote, branch, onConflict:
'preserve-branch' })`. It should:

- run under the write lock;
- replay local commits onto the fetched tip;
- on conflict, preserve the local work on a side branch and adopt the
  remote;
- auto-refresh standing sheets;
- notify the push daemon;
- return `{ outcome, oldCommit, newCommit }`.

Also add `repo.isAncestor(a, b)`.

In: once that ships, delete `store/reconcile.ts`'s git plumbing and call
`repo.sync()` from boot and the webhook. Keep the `outcome` vocabulary the
spec already defines, and map upstream outcomes onto it.

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md): the Reconcile and
  Hot reload sections. Behavior is unchanged; only the mechanism moves.

## Approach

1. File the upstream issue, seeded with cfp's state machine and its
   escape-hatch semantics as the reference design.
2. Once it is released, swap the implementation behind
   `fastify.reconcileDataRepo` and keep its signature.

## Validation

- [x] Upstream issue filed and linked here (gitsheets#301)
- [x] The existing reconcile test matrix (ff, replay, escape-hatch,
      in-sync) passes unchanged against `repo.sync()`
- [x] No `merge-tree`, `commit-tree`, `update-ref` or `merge-base` left in
      `apps/api/src`
- [x] `type-check` + `lint` + full api suite green

## Risks / unknowns

- Upstream may model conflicts differently. If so, the spec's escape-hatch
  semantics win, and we adapt or keep a thin shim.

## Notes

- gitsheets#301 shipped in 2.8.0 (`repo.sync()` + `repo.isAncestor`);
  develop already ran ^2.9.0.
- Outcome mapping: gitsheets `ahead` → `pushed-ahead`; the rest pass
  through. `conflict` can't occur (we always pass `onConflict:
  'preserve-branch'`) and throws if it ever does. gitsheets returns the
  conflict branch as `refs/heads/conflicts/<UTC>`; we strip `refs/heads/`,
  so the name operators see is unchanged.
- **Atomicity.** `repo.sync()` takes its own handle's write lock and throws
  `lock_held` inside `withLock`. Syncing first and rebuilding in a second
  `withLock` leaves a gap: a write queued on the lock runs between the two,
  and write handlers validate against (and spread from) the in-memory
  state, which still holds pre-reload data. A write could then put stale
  fields back on disk over what the reload brought in. Instead, the
  serving repository's `withLock` still wraps the whole reconcile, and
  `reconcileDataRepo` syncs through a short-lived side `Repository` on the
  same gitdir, whose lock is uncontended. The side handle has no live
  sheets and no daemon, so we refresh the store ourselves and pass the
  ahead/replayed tip to `fastify.pushDaemon.notifyCommit`, as before.
- The fetch is still a lock-free `git fetch` with an explicit refspec,
  run before the lock. `sync({ fetch: true })` would fetch inside the same
  call that locks, so it can't fetch outside our critical section.
- Behavior differences: the replay committer is now passed explicitly
  rather than set with `git config user.name/email` on the repo; the
  container entrypoint already configures that identity. The standalone
  `reconcileDataRepo` no longer pushes the working branch by default.
  Pushing always goes through the `push` hand-off, which the API already
  used. The conflict-branch name comes from the wall clock inside
  gitsheets (the `now` option is gone, and tests fake `Date`).
- New test `holds the write lock from the ref move through the rebuild`
  (internal-reload). It holds the lock, queues the reload and then a write,
  and asserts that the ref doesn't move until the lock frees and that
  nothing commits before the rebuild. Both "sync, then withLock" variants
  fail it.

## Follow-ups

- Upstream ask (not yet filed) — let `repo.sync()` run inside a caller's
  critical section, either an `afterMove` callback run under its lock or a
  lock-held mode inside `withLock`. A fetch-only primitive would also let
  us drop the side handle and the last raw `git fetch`.
