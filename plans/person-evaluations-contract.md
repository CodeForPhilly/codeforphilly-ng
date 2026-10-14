---
status: done
depends: [gitsheets-freshness]
specs:
  - specs/behaviors/spam-exclusion.md
pr: 203
---

# Plan: person-evaluations as a gitsheets schema contract

## Scope

The `person-evaluations` schema is defined twice:

- as a JSON Schema in the data repo's `.gitsheets/person-evaluations.toml`;
- as the Zod `PersonEvaluationSchema` in `packages/shared`.

The private spam-pipeline repo also writes to it. Three parties share one
schema, and nothing checks that the copies match.

gitsheets 2.5+ schema contracts fit this case directly. The data repo's
sheet declares `implements = "cfp/person-evaluations/v1"`, and each consumer
opens the sheet with `openSheet({ contract })`, which verifies it at open.

In: define the contract, make the data repo implement it, and make cfp and
the spam pipeline open the sheet against it.

Out: other sheets. Expand later if this pays off. Contracts don't cover
path templates, so they would not have caught the slug-history bug.

## Implements

- [behaviors/spam-exclusion.md](../specs/behaviors/spam-exclusion.md): the
  evaluation record shape becomes a versioned contract.

## Approach

1. Author the contract (likely in the data repo's `empty` branch so every
   branch inherits it).
2. cfp: `openSheet({ contract })` for `person-evaluations` in
   `store/public.ts`, so boot fails loudly on drift.
3. The spam pipeline does the same (coordinate there).

## Validation

- [x] Contract present on all data-repo branches; `git sheet contracts
      verify` clean
- [x] cfp boot fails with a clear error against a deliberately drifted
      config (test)
- [x] Spam pipeline opens against the contract
- [x] `type-check` + `lint` + full api suite green

## Risks / unknowns

- Requires coordinated changes in the private pipeline repo.

## Notes

- In progress until the data-repo commits are pushed. They're prepared
  (contract plus `implements` on `empty`, `fixture`, `legacy-import` and
  `published`), and `gitsheets contracts verify` passes on `published` (27
  human votes).
- The pipeline side is the sheet declaration
  (CodeForPhilly/codeforphilly-spam-detection#1; `contracts verify` passes
  over every machine record). The pipeline never reads the data repo's
  human votes; cfp's `prune-spam` does. So the consumer-side `openSheet({
  contract })` belongs in `prune-spam` once the `gitsheets-scripts`
  refactor lands, not in the pipeline.
- `legacy-import` had no `person-evaluations` config before; it gains one.
- The contract keeps the old sheet-local schema's exact constraints, adding
  only `$id`, `title` and `description` annotations.

- Superseded in scope by [`sheet-contracts`](sheet-contracts.md), which
  generalized this to every sheet with this repo as the publisher. The
  hand-authored `v1` was published as `contracts/…/person-evaluations/v1.json`
  and retired in favor of the generated `v2`, which every data-repo branch
  and the spam pipeline now declare. The pipeline declares it on its own
  sheet; the consumer-side open against the data repo's human votes lives
  in prune-spam (see Follow-ups).

## Follow-ups

- Tracked as: open the evaluations sheets in `prune-spam` against the
  `person-evaluations` contract (noted in PR #204).
