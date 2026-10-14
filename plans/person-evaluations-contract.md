---
status: planned
depends: [gitsheets-freshness]
specs:
  - specs/behaviors/spam-exclusion.md
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

- [ ] Contract present on all data-repo branches; `git sheet contracts
      verify` clean
- [ ] cfp boot fails with a clear error against a deliberately drifted
      config (test)
- [ ] Spam pipeline opens against the contract
- [ ] `type-check` + `lint` + full api suite green

## Risks / unknowns

- Requires coordinated changes in the private pipeline repo.

## Notes

## Follow-ups
