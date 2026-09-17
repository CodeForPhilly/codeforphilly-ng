---
status: done
depends: [saml-authn-statement]
specs:
  - specs/api/saml.md
issues: []
pr: 175
---

# Plan: SAML sign-in return path

## Scope

Slack's "Test configuration" against production got as far as our `/login`,
then dropped the user on `/` instead of finishing the SSO round-trip. Two
defects, found by tracing the first real end-to-end attempt:

1. Both anonymous SAML entry points hand `/login?return=` an **absolute** URL
   (`https://<host>/api/saml/slack/sso/resume`, and `selfUrl()` for
   `/launch`). Every consumer of `?return=` — the login page, the OAuth start,
   the account-claim pages — accepts only a site-relative path (one leading
   `/`, per the laddr/Emergence convention) and falls back to `/` otherwise.
2. Even with a correct path, the login and account-claim pages hand the
   return to React Router. `/api/**` is served by Fastify, not the SPA, so a
   client-side `navigate()` there renders the `*` NotFound page and never
   reaches the resume endpoint. Only the GitHub OAuth path escaped, because
   the API redirects server-side.

In: spec the return contract, fix both entry points, one shared web helper
that hard-navigates for API routes, tests that pin the exact return. Out:
a general "remember where you were" for arbitrary protected pages (already
handled per-page via `?return=`); any change to the assertion itself.

## Implements

- [api/saml.md](../specs/api/saml.md) — `## GET /api/saml/slack/launch` step 1
  and `## GET | POST /api/saml/slack/sso` step 2: the return is a
  site-relative path (never absolute), and the login page performs a full
  navigation when it is an API route.

## Approach

- `apps/api/src/routes/saml.ts`: `RESUME_PATH` constant used by both the park
  redirect and the route registration; `/launch` returns
  `safeReturnPath(request.url)` so `channel`/`redir` ride along. Drop the two
  absolute-URL helpers that no longer have callers.
- `apps/web/src/lib/return-path.ts`: `safeReturn` (was copy-pasted into three
  account-claim pages; the login page had a weaker inline guard without the
  `//` check) and `goToReturn`, which uses `window.location.assign` for
  `/api/` targets and `navigate()` otherwise. All four pages use it.
- Tests: the existing anonymous-redirect assertions only matched
  `^/login?return=` and passed with the absolute URL. Decode the `return` and
  assert the exact path, plus a `/launch?channel=` case.

## Validation

- `npm run type-check && npm run lint && npm test` clean.
- Slack "Test configuration" against the deployed build completes the
  round-trip after a fresh sign-in (the live check this plan exists for).

## Follow-ups

None.
