---
status: done
depends: []
specs:
  - specs/behaviors/storage.md
  - specs/api/people.md
  - specs/api/conventions.md
  - specs/behaviors/legacy-id-mapping.md
issues: []
pr: 148
---

# Plan: spec-drift audit fixes

## Scope

A spec-drift audit (two scoped `spec-drift-auditor` runs) compared `specs/`
against the implementation. This plan records the resolution of the real
findings — and the false positives that were verified away rather than
"fixed."

## Real findings fixed

**Code (apps/api):**

- **Removed the legacy `DELETE /api/people/:slug` route + `softDelete` service
  method.** It was an undocumented admin-only soft-delete running parallel to
  the canonical self|staff `POST /deactivate` — two soft-delete paths with
  diverging authz. Superseded by deactivate/reactivate/purge; deleted.
- **`commit-meta.ts`: added the `Response-Message` trailer** (HTTP reason
  phrase via `node:http` `STATUS_CODES`) — `storage.md#commit-message-shape`
  required it but only `Response-Code` was emitted.
- **`PATCH /api/people/:slug`: tightened the body schema** to enumerate the
  editable fields + `additionalProperties: false`, so privileged fields (esp.
  `accountLevel`) are rejected (422) rather than silently ignored — hardening
  the "account-level only via its dedicated endpoint" rule.

**Specs/docs:**

- **`storage.md` public/private contradiction** — ground-truthed the repo
  visibility (`codeforphilly-data` is **private** on GitHub today). Reconciled:
  it's a private repo holding **public-by-design** content; the dangerous table
  claim that it "contains emails, real names, IPs" (contradicting the whole
  redaction section) was corrected — PII lives in the private store.
- `people.md` Person response shape: documented `slackHandle` and `deletedAt`
  (both returned by the serializer; `deletedAt` gated to self/staff).
- `people.md`: clarified `?accountLevel=` returns an empty 200 to non-staff
  (not 403); corrected the PATCH note to point at the dedicated admin endpoint.
- `legacy-id-mapping.md`: tightened the `byLegacyId` claim — runtime indices
  exist only for people/projects/blog-posts; tags/buzz/updates carry `legacyId`
  for import idempotence only.
- `storage.md`: fixed the `scrub-data.ts` path; clarified that commit bodies
  carry only the caller `summary` (request-body PII redaction is moot).
- `conventions.md`: marked Idempotency-Key as built-but-not-yet-wired (status
  note) — the actual per-route wiring is a follow-up.

## Verified false positives (NOT changed)

- **`reloadInMemoryState` vs `swapPublic`** — the hot-reload path *does* call
  `store.swapPublic` (`reload.ts:76`); the spec was correct. Auditor only read
  `internal.ts`.
- **`perPage` out-of-range "returns 400"** — this app remaps Fastify validation
  errors to **422** (`errors.ts:179`). Spec is correct.
- **account-level `Previous-Account-Level: unknown` "race"** — the 404 throws
  inside the transaction before any write, so no commit (or trailer) persists.

## Validation

- [x] `type-check` + `lint` clean.
- [x] people-account-level 10/10, people-lifecycle 14/14, write-api 28/28
      (52 total across affected suites).

## Follow-ups

- Wire `Idempotency-Key` into at-risk mutating endpoints (starting with
  `POST /api/projects/:slug/updates`) + per-route tests.
