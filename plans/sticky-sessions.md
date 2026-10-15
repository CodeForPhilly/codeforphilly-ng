---
status: done
depends: []
specs:
  - specs/behaviors/authorization.md
  - specs/api/conventions.md
issues: []
---

# Plan: Sessions that stick for months

## Scope

Chris (2026-10-15): "I get logged out soooo quick. I want the login to be
super sticky like weeks/months." The spec already promised a 30-day
sliding session, but the SPA never called `POST /api/auth/refresh`, so
every session ended when the 15-minute access cookie expired. And the
refresh endpoint revoked the old refresh token with a public commit,
which the spec rules out ("no per-request writes anywhere").

**In:** refresh TTL 90 days, sliding; a non-secret `cfp_has_session` hint
cookie set and cleared with the refresh cookie; the SPA refreshes on load
when the hint is present and `/me` says anonymous, and on any 401 (once,
single-flight, then retries); refresh no longer writes a revocation.

**Out:** refresh-token reuse detection (still deferred per the spec);
longer access tokens.

## Implements

- [behaviors/authorization.md](../specs/behaviors/authorization.md#session-model--stateless-jwts)
- [api/conventions.md](../specs/api/conventions.md) — cookie list.

## Approach

1. `REFRESH_TTL_SECONDS` (90 days) exported from `auth/jwt.ts`, used by the
   JWT, the cookie and the session metadata.
2. `setSessionCookies` / `clearSessionCookies` handle `cfp_has_session`.
3. `refreshSession()` + `hasSessionHint()` in `lib/api.ts`; `request()`
   retries after a refresh on 401 (not for `/api/auth/*`); `useAuth`
   refreshes on load when hinted.

## Validation

- [x] `npm run type-check && npm run lint && npm test` clean.
- [x] API test: refresh sets a 90-day refresh cookie and the hint, writes no
  revocation; logout clears the hint.
- [x] Web tests: load-time refresh only with the hint; a 401 refreshes once
  and retries.
- [x] Devbox: with the access cookie gone and the refresh cookie kept, a
  reload comes back signed in.

## Risks / unknowns

- Members signed in before this ships have no hint cookie: their next
  signed-in action still recovers through the 401 path, and the first
  successful refresh sets the hint.

## Notes

- Devbox check (curl, the SPA's sequence): password sign-in set
  `cfp_session`, `cfp_refresh` (90 days) and `cfp_has_session`; with the
  access cookie dropped `/me` was anonymous, `POST /api/auth/refresh`
  returned 200, and `/me` was signed in again. No data-repo commit came
  from the refresh. The SPA's side is covered by the web tests.
- Before this, the refresh endpoint revoked the old token with a public
  commit on every refresh; it never fired in practice because nothing
  called it.

## Follow-ups

- **None.**
