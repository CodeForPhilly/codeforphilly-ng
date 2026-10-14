---
status: done
depends: [person-evaluations-contract]
specs:
  - specs/behaviors/storage.md
  - specs/behaviors/spam-exclusion.md
pr: 212
---

# Plan: every public sheet implements an app-published contract

## Scope

Generalize [`person-evaluations-contract`](person-evaluations-contract.md)
to every public sheet, with this repo as the publisher. Today only API
writes are checked against the Zod schemas; the importer, operator
scripts, the spam pipeline and hand edits write the data repo unchecked.
Contracts move shape enforcement into gitsheets itself.

In:

- A generator in `@cfp/shared` that turns each sheet's Zod schema into a
  contract document at `contracts/codeforphilly.org/<sheet>/v<N>.json`,
  following the spec's generation rules. It replaces the unused
  `.gitsheets/schemas/` output.
- A CI check that regenerates every contract and fails when a committed
  version would change (immutability) or a sheet has none.
- `person-evaluations`: keep `v1` if the generated document is
  canonically identical to the hand-authored one; otherwise publish `v2`
  and move every adopter to it. `v1` is never edited.
- The API opens every public sheet against its contract at boot in
  `declared` mode (identity only, no structural fallback).
- `apps/api/gitsheets/` mirrors the adopted contracts; a test checks each
  mirrored TOML hashes the same as its published JSON.
- Data repo: adopt every contract on `empty`, `fixture`, `legacy-import`
  and `published` via `gitsheets contracts adopt <raw URL @ commit>`, and
  declare `implements` in each sheet config.
- Spam pipeline: re-adopt `person-evaluations` from the published URL.

Out: the events sheets join once #207 merges (same generator, one entry
each).

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md) → Schema contracts
- [behaviors/spam-exclusion.md](../specs/behaviors/spam-exclusion.md)

## Approach

1. Generator (`packages/shared/scripts/generate-contracts.ts`) driven by a
   `{ sheet: { schema, version } }` map exported from `@cfp/shared`.
   Normalize the Zod output: drop `$schema`, set draft-07 and `$id`, strip
   `additionalProperties: false`, collapse `anyOf [T, null]` to `T`, drop
   the default safe-integer bounds, sort `required`.
2. `npm run -w packages/shared generate-contracts` writes the files;
   `check-contracts` (in CI) regenerates into memory and diffs against the
   committed files.
3. The API embeds the published documents (the shared package exports
   them) and opens each sheet with `{ contract }` in `openPublicStore`.
4. Merge, then adopt in the data repo from
   `https://raw.githubusercontent.com/CodeForPhilly/codeforphilly-ng/<sha>/contracts/...`,
   `empty` first, then the other branches, then `published` (only once the
   API serving it is on gitsheets ≥ 2.5).
5. Update the vendored mirror to match `empty`; release; deploy.

## Validation

- [x] Generated contracts committed for every sheet in
      `PUBLIC_SHEET_SCHEMAS`; `check-contracts` passes in CI and fails on
      an edited committed version (test)
- [x] Every generated document compiles as a contract (gitsheets
      `contracts verify` in a test repo) and every fixture record conforms
- [x] Boot verifies every sheet; a drifted contract plus an invalid record
      fails the boot (test)
- [x] `published` adopts every contract: `gitsheets contracts verify` passes
      over all records, and `sources.toml` records the pinned URLs
- [x] Spam pipeline re-adopted from the published URL
- [x] `type-check` + `lint` + full suite green; sandbox, then live, boot
      after adoption

## Risks / unknowns

- Records written before contracts might not satisfy a generated contract
  (e.g. a legacy-import quirk). Adoption's validate-existing pass surfaces
  this before anything is committed. Fix the data or loosen the Zod
  schema, never the generated contract by hand.
- No structural fallback (`declared` mode): an API and a `published`
  branch on different contract versions won't boot together. The release
  and the `published` adoption ship together; v0.6.0 (which still falls
  back) bridges production from gitsheets 2.2 first.

## Notes

- PR #212 merged with `empty`, `fixture` and `legacy-import` adopted
  (`contracts verify` passes on all three, including the full laddr import
  on `legacy-import`). Before adoption, all 23k+ `published` records
  checked clean against the generated contracts.
- Contracts are generated from the Zod **input** side, so a defaulted
  field is optional with its `default` declared (gitsheets fills it on
  write) rather than required.
- `person-evaluations` moved to a generated v2 (adds the `evaluatedAt`
  datetime pattern); the hand-authored v1 stays published as
  `contracts/…/v1.json` and is no longer declared anywhere in the data repo.
- No structural fallback (`declared` mode), per Chris: the data repo moves
  in lockstep with the app.
- Contracts caught three invalid test fixtures on their first run.
- `published` adopted every contract (`21966b8`, `.gitsheets/` identical to
  `empty`, `contracts verify` over every record) in lockstep with v0.7.0,
  then sandbox and production deployed back to back. Both booted in
  declared mode with all 16 sheets verified and 0 restarts.
- The events backfill (codeforphilly-data #20) merged afterwards as records
  only. Both environments took the incremental hot-reload path.
- The spam pipeline adopted the published `person-evaluations` v2
  (CodeForPhilly/codeforphilly-spam-detection#1).

## Follow-ups

- Tracked as: JarvusInnovations/gitsheets#304 (flag template fields the
  schema doesn't require) would move part of `sheet-configs.test.ts`'s guard
  into gitsheets itself.
- Tracked as: a gitsheets change to contract canonicalization would break
  declared-mode identity on the next bump. Re-adopt every contract in
  lockstep if one ships.
