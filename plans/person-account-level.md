---
status: done
depends: []
specs:
  - specs/api/people.md
issues:
  - 33
pr: 147
---

# Plan: person account-level change endpoint

## Scope

Deferred from write-api (#29): `accountLevel` was listed under People mutations
but never shipped a dedicated endpoint. The spec called for it as the *only*
way to change `accountLevel` (never via the generic `PATCH`), so the privilege
change is explicit and audit-logged. Issue #33.

## Implements

- [api/people.md](../specs/api/people.md) — `POST /api/people/:slug/account-level`
  (administrator-only): request body, 200 response, audit trailers,
  last-administrator guard, error table. Promoted from a deferred stub to a
  full section.

## Approach

- **Write service** `PersonWriteService.setAccountLevel(tx, slug, level, session)`:
  `requireAuth('administrator')`; idempotent no-op when the level is unchanged;
  **last-administrator guard** — refuse to demote the only `administrator`
  (counts admins in state; `<= 1` → `ApiValidationError` → 422); returns the
  updated person + `previousLevel`.
- **Route** `POST /api/people/:slug/account-level`: body schema validates the
  `level` enum; reads the current level from in-memory state up-front to set the
  `Previous-Account-Level` / `New-Account-Level` audit trailers; transacts with
  `Action: account-level.change`; returns the updated person (200).

## Validation

- [x] anon → 401; regular user → 403; staff (non-admin) → 403; admin → 200.
- [x] invalid `level` → 422 (schema validation — this app maps Fastify
      validation errors to 422, not 400; spec + test aligned to that).
- [x] promote user→staff, demote staff→user reflected in the response.
- [x] idempotent no-op (same level) → 200.
- [x] last-administrator self-demotion → 422; demoting an admin while a second
      admin exists → 200.
- [x] audit trail: commit carries `Action: account-level.change` +
      `Previous-Account-Level` + `New-Account-Level` trailers (asserted by
      reading the bare repo's HEAD commit).
- [x] `type-check` + `lint` clean; people-account-level 10/10; full api suite green.

## Notes

- Sibling to the deactivate/reactivate/purge admin verbs ([person-deactivate-purge](person-deactivate-purge.md)).
- The spec originally documented `400` for a bad body; corrected to `422` to
  match the codebase's established schema-validation mapping (caught by the test).

## Follow-ups

- `POST /api/people/:slug/impersonate` remains explicitly deferred (noted in the
  spec) — admin tooling can grow into it later.
