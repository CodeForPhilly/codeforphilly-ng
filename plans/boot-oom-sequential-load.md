---
status: done
depends: []
specs: []
issues:
  - 132
pr: 134
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

- [x] Live pod boots and reaches `/api/health/ready` 200 on the standard node
      size, 0 restarts, ~0.48 GB retained (per-phase boot instrumentation).
- [x] `npm run -w apps/api type-check && npm run lint` clean; loader/store/memory
      tests pass (12/12).
- [x] Deployed `:sandbox` image boots without OOM on the normal config
      (heap 2048 / limit 2560Mi).

## Risks

- Negligible. Sequential reads are slower by a few hundred ms at boot only
  (not request-path); the data and order are identical.

## Notes

- **The real bug was concurrency, not memory size or data volume.** Per-phase
  heap logging in the live pod showed reconcile + push-daemon + private-store
  load all sat at ~60 MB; the entire balloon was the concurrent `Promise.all`
  read in `loadInMemoryState`. Retained state is ~0.48 GB.
- The diagnosis ruled out several earlier hypotheses: public people count (the
  prune didn't change the crash), the private store (11 MB), and reconcile/
  push-daemon git-object caching (flat at boot). The gitsheets read path *is*
  memory-heavy per read, but the OOM was specifically the eleven reads peaking
  together.
- **Sibling changes from the same investigation:** #131 (heap 1536→2048,
  limit 2Gi→2.5Gi) was a mitigation, now redundant but harmless headroom — left
  as-is. #133 (spam prune) shipped to production `published` (31,832→18,203
  people); independently worthwhile but not the OOM fix.

## Follow-ups

- **Tracked as #132** — broader heap-footprint work (the gitsheets per-read
  cost and ~2× retention of raw TOML + parsed records). Optional now that boot
  fits comfortably, but the lever if the dataset grows.
- **Deferred (ops):** the throwaway `ghcr.io/codeforphilly/codeforphilly-ng:heapdiag`
  image tag was pushed during diagnosis; harmless but can be deleted from GHCR.
