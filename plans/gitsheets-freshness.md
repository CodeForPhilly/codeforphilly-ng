---
status: planned
depends: [gitsheets-2x-bump]
specs:
  - specs/behaviors/storage.md
issues:
  - 150
---

# Plan: gitsheets 2.7 — retire the stale-Sheet workarounds

## Scope

The second half of #150, unblocked: upstream `gitsheets#184` (per-sheet
refresh) shipped via gitsheets PR #239 in **2.3.1** (2.3.0 never reached
npm). Bump `gitsheets` `^2.2.0` → `^2.7.0` and use the new APIs to delete the
three workarounds we carry for the stale-`Sheet` cache, plus two shims that
2.3's marshal/typing changes made redundant.

In:

- Bump to `^2.7.0` (core-napi 0.1.1 → 0.5.0).
- **`swapPublic`** → `store.refresh()`.
- **Raw `git cat-file` attachment streaming** → `repo.readBlobStream()`.
- **`data-repo-lock`** → `repo.withLock()`, which shares the mutex
  `transact` uses. This **fixes a real race**: today no write path takes
  `dataRepoLock`, so the hot-reload webhook *can* race a `transact`, despite
  `storage.md` claiming otherwise. The rebuild also runs after the lock is
  released, so a write landing mid-`loadInMemoryState` can be clobbered by
  `swapInPlace`.
- Drop `stripNullish` (2.3 drops null/undefined keys natively, recursively —
  gitsheets #241) and the `asValidator` / `as PublicStore` casts (2.3
  Standard Schema typing is cast-free — gitsheets #242).

Out:

- `Sheet.get(path)`, range/date-bucket queries, schema contracts — no
  current consumer (see Follow-ups for contracts).
- The 25 unused `defineIndex` definitions — separate cleanup.

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md) — hot-reload
  concurrency ("a webhook can't race a `transact`-driven write") becomes
  true; the "caching limitation" section is retired.

## Approach

1. **Spec first** (own commit): rewrite `storage.md` → "Direct gitsheets
   reads after a transact (caching limitation)" to state that standing sheets
   auto-refresh after a committing transact and that out-of-process ref moves
   (reconcile) require `store.refresh()`. Reword the hot-reload
   **Concurrency** bullet to say reconcile **and rebuild** run under the
   repo's transact mutex.
2. **Bump**: `npm install gitsheets@^2.7.0 -w apps/api` — generated commit
   first.
3. **Lock**: delete `lib/data-repo-lock.ts` and the `dataRepoLock`
   decoration in `plugins/reconcile.ts`. Boot reconcile and the webhook run
   `fastify.publicRepo.withLock(...)`; the webhook wraps **reconcile +
   `reloadInMemoryStateAndFts`** in one `withLock` so no write lands between
   the ref move and the in-memory swap. `withLock` is not reentrant — nothing
   inside may call `transact` (reconcile only shells out to git; verify).
   Consider running `git fetch` outside the lock so writes aren't blocked on
   network, relying on reconcile's existing CAS `update-ref`.
4. **Refresh**: delete `Store.swapPublic`; `reloadInMemoryStateAndFts`
   calls `await store.public.refresh()` then `loadInMemoryState`. Drop the
   re-open and the `wireSheetIndices` re-run (index builds are invalidated on
   rebind).
5. **Attachments**: replace the spawn + first-chunk race in
   `routes/attachments.ts` with `publicRepo.readBlobStream('HEAD', key)`;
   map `NotFoundError` → 404, keep `validateKey`, attach an `'error'` handler
   (the stream is raw child stdout and doesn't surface exit codes). This also
   fixes an empty blob being reported as 404.
6. **Shims**: delete `stripNullish`/`asValidator` in `store/public.ts`; pass
   the Zod schemas directly (`satisfies ValidatorMap` if it type-checks).
   Optionally pass Buffers straight to `setAttachments` in `routes/people.ts`
   and the importer, dropping the separate `writeBlob`.
7. **Tests**: replace `git show HEAD:…` / `swapPublic` fallbacks in tests
   with plain sheet reads (auto-refresh makes them fresh).

## Validation

- [ ] `storage.md` updated in its own commit before the code changes
- [ ] `gitsheets` resolves to ≥ 2.7.0; `@gitsheets/core-napi` loads in the
      Alpine (`linux-x64-musl`) image
- [ ] `data-repo-lock.ts`, `swapPublic`, `stripNullish`, `asValidator`, and
      the `cat-file` spawn in `attachments.ts` are gone (grep clean)
- [ ] New test: a write issued while a hot-reload is mid-rebuild is
      serialized behind it and survives the reload (no clobber)
- [ ] Attachments: 200 stream for an existing key, 404 for a missing key,
      correct handling of an empty blob
- [ ] Write of a record with cleared optional fields still produces no
      `null` keys on disk (byte-identical to today); no schema emits a `null`
      array element (2.3 now throws on those)
- [ ] `type-check` + `lint` + full api suite green
- [ ] Sandbox: boot to ready and one hot-reload webhook round-trip succeed;
      note boot/reload timing vs. 2.2 (2.7 reads records in-core — gitsheets
      #295)

## Risks / unknowns

- **Native addon jump** (core-napi 0.1 → 0.5). Mitigated by the sandbox
  check before live.
- **Behavior change**: standing sheets now see new commits. The revocation
  sweeper (`auth/middleware.ts`) reads a standing sheet — it gets fresher,
  which is the intent, but watch its tests.
- **`refresh()` resolves `HEAD`** — relies on the bare clone's `HEAD`
  pointing at `refs/heads/$CFP_DATA_BRANCH`, which is what reconcile moves.
  Assert it.
- **Holding the transact mutex across reconcile** pauses writes for the
  duration; acceptable for a webhook that fires on data-repo pushes, but keep
  the fetch outside if it's slow.

## Notes

## Follow-ups
