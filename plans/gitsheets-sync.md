---
status: in-progress
depends: [gitsheets-freshness]
specs:
  - specs/behaviors/storage.md
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
- [ ] The existing reconcile test matrix (ff, replay, escape-hatch,
      in-sync) passes unchanged against `repo.sync()`
- [ ] No `merge-tree`, `commit-tree`, `update-ref` or `merge-base` left in
      `apps/api/src`
- [ ] `type-check` + `lint` + full api suite green

## Risks / unknowns

- Upstream may model conflicts differently. If so, the spec's escape-hatch
  semantics win, and we adapt or keep a thin shim.

## Notes

## Follow-ups
