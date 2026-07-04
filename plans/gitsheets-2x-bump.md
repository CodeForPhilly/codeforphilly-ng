---
status: in-progress
depends: []
specs:
  - specs/behaviors/storage.md
issues:
  - 150
pr:
---

# Plan: upgrade gitsheets 1.4.1 → 2.x (Rust core)

## Scope

Bump `gitsheets` from `^1.4.1` to `^2.2.0` (the Rust-core line). This plan is
the **version bump only** — the "retire the three cache workarounds" half of
issue #150 is **out of scope and blocked** on upstream `gitsheets#184`
(per-sheet refresh API), which is OPEN, unassigned, and **not shipped in 2.x**
(verified: 2.x `Sheet` still carries the pre-commit `dataTree` snapshot). The
workarounds are therefore **ported/verified, not deleted**.

## What actually changes in 2.x (verified against the gitsheets source)

- **The Node public API is deliberately unchanged** — 2.x is an engine rewrite
  behind the same `openRepo`/`openStore`/`Sheet`/`Transaction` surface
  (`specs/rust-core.md` → "No consumer-visible public-API change"). So most of
  our code compiles as-is.
- **`hologit` is dropped as a gitsheets dependency** (2.x deps are
  `@gitsheets/core-napi` + csv/rfc6902/sort-keys/yargs — no hologit). This is
  the **one real breaking change for us**: our avatar-blob-write path imports
  `BlobObject` from `hologit` and uses `publicRepo.hologitRepo`.
- **Two deliberate one-time byte re-baselines** (data-level, lossless — values
  unchanged, only formatting):
  1. **Canonical TOML**: Rust `toml`/`toml_edit` drops integer underscores
     (`legacyId = 31_618` → `31618`) across all sheets (matches gitsheets#196).
  2. **Markdown body**: content-typed sheets (our **blog-posts**) normalize the
     body via native `dprint` instead of `markdownlint`.

## Work

### 1. Dependency bump

- `npm install gitsheets@^2.2.0 -w apps/api`. Commit the generated
  package.json + lock change first (drops hologit transitively).

### 2. Migrate the blob-write path off `hologit` (the real code change)

Replace the `hologit` `BlobObject.write(publicRepo.hologitRepo, buf)` pattern
with the 2.x `Repository.writeBlob(buf): Promise<BlobHandle>` + `setAttachment`
API. Sites:

- `apps/api/src/routes/people.ts:19,407,430-431` (avatar upload)
- `apps/api/scripts/import-laddr/importer.ts:95,503,516-517,583-590` (legacy
  avatar + media import)
- Drop the `as unknown as string` casts — 2.x `writeBlob` takes a `Buffer`.
- Confirm the exact 2.x `setAttachment(s)` signature in the gitsheets `Sheet`
  API (`AttachmentBlobHandle` / `BlobHandle`) and wire accordingly.
- Grep for any other `hologit` / `hologitRepo` / `BlobObject` / `TreeObject`
  references and migrate; ensure `hologit` is NOT needed as a direct dep.

### 3. Verify (do NOT delete) the #184 workarounds still compile + work

- `apps/api/src/store/store.ts` `swapPublic()` — re-opens the store via
  `openPublicStore`; API unchanged, should be fine. Confirm it doesn't touch
  `hologitRepo`.
- `apps/api/src/routes/attachments.ts` — raw `git cat-file` (git-level, not
  gitsheets) — unaffected; confirm.
- `apps/api/src/lib/data-repo-lock.ts` — our own mutex — unaffected; confirm.

### 4. Incidental cast checks (issue #150)

- `apps/api/src/store/public.ts` `asValidator()` (Zod v4 ↔ `StandardSchemaV1`).
  2.x still exports `StandardSchemaV1`/`ValidatorMap`; keep the cast if still
  needed, simplify if 2.x makes it clean. Don't force it.

### 5. Validation

- `npm run -w packages/shared build` (exports map points at dist), then
  `npm run type-check` + `npm run lint` clean.
- **Full api test suite green.** The byte re-baseline will break any test that
  asserts exact TOML bytes containing integer underscores, or exact blog-post
  body bytes — fix those to the new canonical form (they're re-baseline
  updates, not behavior changes; note each in the commit).
- **Byte-parity check on real data**: load the `published` import under 2.x and
  confirm the change is **lossless** — parsed values identical to 1.4.1, only
  the documented re-baselines (integer underscores, markdown bodies) differ.
  (Mirror the approach used for the 1.4.1 swap.)
- Sanity-check the migrated blob path end to end: an avatar upload writes both
  `avatar.jpg` + `avatar-128.jpg` attachments with the right `avatarKey`.

## Out of scope / follow-ups

- **Retiring `swapPublic` / attachments `git cat-file` / `data-repo-lock`** —
  blocked on `gitsheets#184`; separate effort once that lands upstream. Keep
  #150's second half open (or split it out).
- **Data-repo re-normalization commit** — under 2.x, records re-serialize
  without integer underscores as they're written, so the repo drifts to mixed
  format until fully rewritten. A deliberate one-time re-normalize (rewrite all
  records) is cleaner but is a **data-ops task on `codeforphilly-data`**, not
  part of this code bump. Flag it; do it deliberately (likely bundled with the
  cutover data prep).
- **Timing note:** 2.x is days old (Rust rewrite) and we're near production
  cutover (#54). This bump is validated but should merge on a deliberate
  decision, not reflexively before cutover.

## Validation checklist

- [ ] deps bumped; hologit gone from lock
- [ ] blob-write path migrated off hologit; casts removed
- [ ] workarounds verified (compile + covered by tests)
- [ ] type-check + lint clean
- [ ] full api suite green (re-baseline test updates noted)
- [ ] byte-parity on `published` = lossless (only documented re-baselines)
