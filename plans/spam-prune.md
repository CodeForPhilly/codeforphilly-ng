---
status: in-progress
depends: []
specs:
  - specs/behaviors/spam-exclusion.md
issues:
  - 132
pr:
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

- [ ] Dry-run on a fresh clone reports: people before/after (~31.8k → ~12k),
      cascade deletion counts, authors-unlinked count.
- [ ] **Spot-check**: sample pruned people + their cascaded records look like
      spam (empty/throwaway), not real members — a real-looking cascade is a
      signal the threshold/rule is too aggressive.
- [ ] Re-running is idempotent (second run = no changes).
- [ ] After applying to a clone, a local API boot loads the pruned set under
      ~1.5 GB heap (fits the current nodes).
- [ ] `npm run type-check && npm run lint` clean.

## Risks

- False-positive pruning of real members — mitigated by the conservative rule
  (a single confident `legit` protects) and the spot-check gate. Originals
  remain on `legacy-import`; evaluations remain on `spam-detection`; re-import
  recovers anyone wrongly removed.
- Large single transaction (≈19.5k deletes) — offline script, run with ample
  heap; chunk if needed.

## Notes

## Follow-ups
