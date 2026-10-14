---
status: planned
depends: [gitsheets-freshness]
specs:
  - specs/behaviors/storage.md
---

# Plan: incremental hot reload via `sheet.diffFrom`

## Scope

Today hot reload rebuilds every in-memory map and the full FTS index from
scratch (`store/memory/reload.ts`), and after `gitsheets-freshness` it does
so while holding the transact mutex. The cost scales with the dataset, which
has OOM'd before (see `loader.ts` history), not with the change.

gitsheets already exposes `sheet.diffFrom(oldCommit, { records: true })`.
For each sheet, diff the pre-reconcile commit against the new `HEAD` and
replay the changed records through the same `StateApply` upsert/delete paths
that writes use, and through incremental FTS upserts/deletes.

In:

- Diff-driven apply for every sheet loaded into memory.
- Fall back to a full rebuild when the diff is empty-but-suspicious or very
  large (threshold TBD), or when `.gitsheets/` configs changed.

Out: the boot path stays a full load.

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md) → Hot reload. The
  atomicity rule changes from "build fresh state, then swap" to "apply the
  diff under the lock, falling back to a full rebuild". Spec edit first.

## Approach

1. Spec edit (own commit).
2. `reloadInMemoryStateAndFts(fastify, { from: oldCommit })` iterates
   sheets, calls `diffFrom`, and dispatches adds, modifies and deletes to
   `StateApply` and the FTS engine.
3. Secondary indexes (legacy-id, slug-history, buzz-by-slug) must update
   through the same `StateApply` paths. Audit that every index is maintained
   there and not only by the loader.

## Validation

- [ ] Spec updated first
- [ ] Equivalence test: for a series of upstream commits (add, modify,
      delete, rename in each sheet), state after the incremental apply deep-
      equals state after a full rebuild
- [ ] Config change under `.gitsheets/` triggers the full-rebuild fallback
- [ ] Sandbox: reload timing and peak heap for a one-record upstream change
      vs. a full rebuild
- [ ] `type-check` + `lint` + full api suite green

## Risks / unknowns

- Any index that only the loader maintains will silently drift. The
  equivalence test is the guard.
- `diffFrom` cost across a large rebase/escape-hatch jump. Measure it.

## Notes

## Follow-ups
