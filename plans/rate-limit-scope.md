---
status: in-progress
depends: [saml-login-return-path]
specs:
  - specs/api/conventions.md
  - specs/api/auth.md
issues: []
pr: null
---

# Plan: scope and loosen the rate limiter

## Scope

Minutes after the 2026-09-17 cutover, visitors (including the Slack SAML
test) started getting `429 rate_limited`. Three compounding causes:

1. The limiter's `onRequest` hook counted **every** request — SPA shell,
   JS/CSS chunks, thumbnails — against the 60/min unauthenticated read cap.
   One page load is dozens of requests.
2. `GET /api/auth/me`, which the SPA calls on every page load, lived in the
   10/min `/api/auth/*` bucket alongside the credential endpoints.
3. Production's NodeBalancer does not preserve client addresses, so Envoy —
   and therefore `X-Forwarded-For` — sees one address for all visitors. Every
   per-IP bucket is effectively site-wide (cfp-live-cluster #201).

In: spec the scoping and the new caps, implement, test. Out: PROXY protocol
on the NodeBalancer (infra, tracked separately); tightening the credential
cap back down once real client IPs arrive.

## Implements

- [api/conventions.md](../specs/api/conventions.md) — `## Rate limiting`:
  `/api/**` only; credential endpoints enumerated; new caps and the
  shared-address caveat.
- [api/auth.md](../specs/api/auth.md) — the 429 line under GitHub start
  references the credential-endpoint cap instead of a stale number.

## Approach

- `apps/api/src/plugins/rate-limit.ts`: early return for non-`/api/` paths;
  `isCredentialPath()` replaces the `/api/auth` prefix test; caps in an
  exported `RATE_LIMITS` table so tests assert against the source of truth.
- Tests: assets and the SPA fallthrough are uncounted; `/api/auth/me` is a
  read, not a credential call; credential paths share one IP bucket; the read
  cap still trips at `RATE_LIMITS.unauthenticatedReadsPerIp + 1`.

## Validation

- `npm run type-check && npm run lint && npm test` clean.
- After deploy: no 429s in the pod log during normal browsing; Slack SAML test
  completes.

## Follow-ups

- Tracked as: cfp-live-cluster #201 (PROXY protocol so per-IP is per visitor).
