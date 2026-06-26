---
status: in-progress
depends: []
specs: []
issues:
  - 132
pr:
---

# Plan: fix boot OOM — load sheets sequentially, not concurrently

## Scope

The runtime OOM'd on a cold boot (`FATAL ERROR: Reached heap limit`) while
building in-memory state from the full `published` import. Extensive diagnosis
(per-phase heap logging in the live pod) pinpointed the cause: `loadInMemoryState`
read all eleven sheets via `Promise.all`, so every sheet's transient
read/decompress/parse buffers peaked **at the same instant**. That combined
spike exceeded the heap ceiling, even though the *retained* state is only
~0.5 GB. The fix is to read the sheets **sequentially**.

What ships:

- **`apps/api/src/store/memory/loader.ts`** — replace the `Promise.all` over the
  eleven `queryAll()` reads with sequential `await`s. Same result, same retained
  memory; the peak is bounded to the single largest sheet.

## Implements

No spec change — the storage spec never mandated concurrent loading. This is an
implementation fix to the boot path. Tracked against #132 (heap footprint).

## Approach

Sequential `await publicStore.<sheet>.queryAll()` for each sheet, with a comment
explaining why concurrency is avoided. No change to the indexing loops or the
returned state shape/order.

## Validation

- [ ] Live pod boots and reaches `/api/health/ready` 200 on the standard node
      size (heap measured ~0.48 GB retained via temporary boot instrumentation).
- [ ] `npm run -w apps/api type-check && npm run lint` clean; loader/store tests pass.
- [ ] Deployed `:sandbox` image boots without OOM.

## Risks

- Negligible. Sequential reads are slower by a few hundred ms at boot only
  (not request-path); the data and order are identical.

## Notes

## Follow-ups
