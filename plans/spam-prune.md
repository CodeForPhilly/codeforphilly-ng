---
status: done
depends: []
specs:
  - specs/behaviors/spam-exclusion.md
issues:
  - 132
pr: 133
---

# Plan: prune confident-spam people from published

## Scope

A cold boot rebuilding in-memory state from the full `published` import (31,832
people, ~61% flagged spam by the offline `person-evaluations` pass) exceeds the
heap budget on the 4 GB sandbox nodes. Rather than double node cost, prune the
confident-spam people from `published` so the runtime loads only real members.

What ships:

- **`apps/api/scripts/prune-spam.ts`** — re-runnable operator script that reads
  `person-evaluations` verdicts from `spam-detection`, applies the aggregation
  rule from the spec, and cascade-prunes confident-spam people from `published`.
- No app/loader change — `published` simply ends up smaller.

## Implements

- [spam-exclusion.md](../specs/behaviors/spam-exclusion.md) — verdict
  aggregation rule, prune + cascade scope, idempotency.

## Approach

1. **Read verdicts** from `spam-detection`'s `person-evaluations` sheet
   efficiently (git, read-only — 54k records; avoid loading them into gitsheets
   memory). Aggregate per person: prune iff ≥1 `spam` verdict at
   confidence ≥ `--threshold` (default 0.8) AND no `legit` verdict.
2. **Prune on `published`** via one gitsheets transaction (mirroring
   `import-laddr/importer.ts`): `store.people.delete` each spam person; cascade
   `project-membership` / `help-wanted-interest` / person `tag-assignment`
   deletes; `patch` `project-update.authorId → null`. Idempotent.
3. **`--dry-run`** reports counts + sample without committing.
4. CLI mirrors the importer: `--data-repo`/`$CFP_DATA_REPO_PATH`,
   `--evaluations-ref` (default `spam-detection`), `--branch` (default
   `published`), `--threshold`, `--dry-run`, `--verbose`.

## Validation

- [x] Dry-run on a fresh clone reports: 31,832 → 18,203 (pruned 13,629),
      1,710 person tag-assignments deleted, 0 memberships/authors touched.
- [x] **Spot-check**: 9/10 sampled prunes were unambiguous bulk commercial
      spam; the 1 with a real project membership (quinn / phillytruce) is now
      protected by the membership clause added after the spot-check.
- [x] Re-running is idempotent (second run = 0 changes).
- [x] Pruned set loads + builds FTS in **459 MB heap / 658 MB RSS** at a 1536
      ceiling (full data OOM'd >2.5 GB) — fits the current nodes with margin.
- [x] `npm run type-check && npm run lint` clean.

## Risks

- False-positive pruning of real members — mitigated by the conservative rule
  (a single confident `legit` protects) and the spot-check gate. Originals
  remain on `legacy-import`; evaluations remain on `spam-detection`; re-import
  recovers anyone wrongly removed.
- Large single transaction (≈19.5k deletes) — offline script, run with ample
  heap; chunk if needed.

## Notes

- The memory win is **super-linear**, not proportional to the 43% people cut:
  removing spam dropped the cold-boot heap from >2.5 GB (OOM) to ~459 MB. Spam
  accounts carry long marketing-copy bios, so they're individually large records
  and heavy FTS terms — pruning them removes outsized memory, not just a head
  count. So even the original 1536 heap now fits comfortably; the #131 bump to
  2048/2.5Gi is just headroom.
- **Membership protection added after the spot-check.** The first pass would have
  pruned `quinn`, who had a real `phillytruce` membership (spam verdict rested on
  one crypto-framed intro message). Added "no project membership" to the protect
  rule — across all 13,629 prunes only 1 person was protected, confirming spam
  accounts essentially never hold memberships (so the clause is near-free).
- The prune is a **data-pipeline** step, not runtime — `loader.ts` is untouched.
  `published` is spam-free only by running prune after every import/merge; this
  ordering is now documented in spam-detection.md + cutover.md.

## Follow-ups

- **Tracked as #132** — investigate the in-memory footprint itself (the per-record
  heap cost), so growth doesn't re-pressure the budget even with spam pruned.
- **Deferred (ops):** fold merge+prune into a single `publish`/rebuild step so the
  ordering can't be skipped by hand. Documented for now; not yet automated. No
  issue filed — revisit when the publish flow gets automated past the manual
  cutover runbook.
