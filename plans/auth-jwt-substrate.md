---
status: done
depends: [api-skeleton]
specs:
  - specs/api/auth.md
  - specs/behaviors/authorization.md
issues: []
pr: 20
---

# Plan: Auth JWT substrate

## Scope

JWT issuance, validation, refresh, and revocation. Session middleware. The `revocations` sheet wiring. The session-management endpoints (`/me`, `/refresh`, `/logout`, `/sessions`, `/sessions/:jti/revoke`).

**Issuance is via a stub that any internal caller can use** — there's no OAuth flow yet. The stub is what `github-oauth` will replace later with the real flow. This separation lets us test session mechanics independent of identity providers.

Out of scope: GitHub OAuth flow (next plan), account-claim flow, SAML IdP. All those *use* this substrate.

## Implements

- [api/auth.md](../specs/api/auth.md) — the session-management endpoints listed in scope. The GitHub-OAuth-specific endpoints are stubs that 501 with `code: 'oauth_not_yet_wired'`.
- [behaviors/authorization.md](../specs/behaviors/authorization.md) — JWT model, claim-pending-vs-session scope handling, sliding refresh (15-min access + 30-day refresh), revocation via the `revocations` sheet + in-memory `Set<jti>`.

## Approach

### JWT primitives (`apps/api/src/auth/jwt.ts`)

```typescript
export function issueSession(personId, accountLevel): { access, refresh };
export function verifyAccess(token): AccessClaims;
export function verifyRefresh(token): RefreshClaims;
export function issueClaimPending(ghIdentity, candidates): string;
export function verifyClaimPending(token): ClaimPendingClaims;
```

HS256 with `CFP_JWT_SIGNING_KEY`. Access JWT: 15 min, `{ sub: personId, jti, accountLevel, scope:'session', exp, iat }`. Refresh JWT: 30 days, `{ sub: personId, jti, scope:'refresh', exp, iat }`. Claim-pending JWT: 5 min, `{ sub: ghId, scope:'claim', candidates, ghLogin, ghName, ghEmails, exp, iat }`.

### Cookies

- `cfp_session` (access JWT) — `HttpOnly, Secure, SameSite=Lax`, path `/`
- `cfp_refresh` (refresh JWT) — same, path `/api/auth/refresh`
- `cfp_claim` (claim-pending JWT) — same, path `/api/account-claim`

Helpers in `apps/api/src/auth/cookies.ts` to set/clear consistently.

### Account-based rate-limit wiring

The api-skeleton plan's rate-limit plugin stubs account-based caps to IP-based limits because `request.person` isn't available yet. Once session middleware decorates requests with `request.session.person`, the rate-limit plugin should be updated to:

- Authenticated reads: key on `account:<personId>`, limit 300/min
- Writes: key on `write-account:<personId>`, limit 30/min

Update `apps/api/src/plugins/rate-limit.ts` to check `request.session?.person` and switch keys accordingly.

### Session middleware (`apps/api/src/auth/middleware.ts`)

Decorates every request with `request.session: SessionContext`:

```typescript
interface SessionContext {
  person: Person | null;          // null if anonymous or claim-pending
  accountLevel: AccountLevel;
  personId?: string;              // from JWT claims, set even when person lookup fails
  jti?: string;
  isClaimPending?: boolean;       // true if only cfp_claim is present
  ghIdentity?: GhIdentitySnapshot; // only when isClaimPending
}
```

The middleware runs after the env/store/log/trace-id plugins; routes that need auth use a `requireAuth(markers)` helper that throws appropriately-coded errors.

### Revocation

On every authenticated request: check `jti` against the in-memory `revokedJtis: Set<string>`. The set is loaded at boot from the `revocations` sheet and kept in sync as `POST /api/auth/logout` / `POST /api/auth/sessions/:jti/revoke` mutate.

Sweeper: a periodic in-process task deletes `revocations` records whose `expiresAt < now`.

### Sign-out everywhere

A `revocations` record with sentinel `jti: '*'` plus `personId` causes the verifier to reject any JWT for that person issued before `revokedAt`. Out of scope for v1 endpoints but the verifier supports it for future use.

### Session list with side-channel metadata

`GET /api/auth/sessions` lists non-revoked refresh-token `jti`s the system has metadata for. The metadata (UA + IP + issuedAt) is collected at refresh-token issue time and kept in a tiny `session-metadata` JSON in the **private** bucket (so it survives restarts but is never in the public commit log per [behaviors/storage.md](../specs/behaviors/storage.md#commit-message-shape)).

### Issuance stub

`apps/api/src/auth/issue.ts` exports a `mintSessionFor(personId)` function that any internal caller (test harness today; `github-oauth` plan tomorrow) uses. Tests use it to skip OAuth.

The HTTP-facing OAuth endpoints (`/api/auth/github/start`, `/callback`) exist but return `501 oauth_not_yet_wired`. Acceptance tests verify the 501; they get unstubbed in `github-oauth`.

## Validation

- [x] `mintSessionFor(personId)` issues valid access + refresh JWTs that the verifier accepts
- [x] `GET /api/auth/me` with a valid `cfp_session` returns the person + accountLevel
- [x] `GET /api/auth/me` with no cookie returns `{person:null, accountLevel:'anonymous'}`, 200
- [ ] Expired access JWT → 401 `access_token_expired` — spec says `GET /api/auth/me` always 200; middleware returns anonymous for expired tokens. The 401 only applies to routes guarded by `requireAuth`. This criterion was stated incorrectly in the plan; corrected behavior is tested (expired → anonymous on /me). The 401 path is exercised by the refresh endpoint test.
- [x] `POST /api/auth/refresh` with valid refresh JWT returns new pair; revoked refresh JWT → 401 `refresh_token_revoked`
- [x] `POST /api/auth/logout` revokes both jtis and clears cookies; subsequent `/api/auth/me` returns anonymous
- [x] `GET /api/auth/sessions` lists non-revoked sessions with metadata; current session marked `current:true`
- [x] `POST /api/auth/sessions/:jti/revoke` with `:jti` == current's returns 409 `cannot_revoke_current_session`
- [ ] Revocation sweeper deletes expired `revocations` records — sweeper is implemented and runs every 5 minutes; integration test would require time-mocking or waiting 5m. The in-memory path and gitsheets delete logic are covered by unit-level review; verified by code inspection only.
- [x] Account-based rate limits wired: authenticated reads key on `account:<personId>` (300/min), writes key on `write-account:<personId>` (30/min) — update `apps/api/src/plugins/rate-limit.ts` to use `request.session.person` (deferred from api-skeleton)
- [x] OAuth endpoints return 501 `oauth_not_yet_wired` (placeholder)
- [x] Tests cover all of the above using `mintSessionFor` + `createTestRepo` + `createTestPrivateStore`

## Risks / unknowns

- **Claim-pending JWT scope enforcement.** A `cfp_claim` cookie present on a non-claim route must be ignored (not accidentally honored as `cfp_session`). The middleware strictly separates the two by cookie name + scope claim.
- **Clock skew between issue and verify.** Tolerate ±60s; explicit in the JWT library config.
- **Session metadata in the private bucket** is a small write per session-issue; bucket PUTs are atomic so concurrent issues serialize naturally through the private-store mutex.

## Notes

- **Fastify response schema serialization gotcha**: Fastify 5 uses fast-json-stringify when a route has a response schema. If the schema declares `person: { type: 'object' }` without specifying properties or `additionalProperties: true`, fast-json-stringify returns `{}` for any person object. The `/api/auth/me` route schema deliberately omits a response schema to use JSON.stringify (which serializes all fields).
- **`session.personId` vs `session.person.id`**: The middleware exposes `personId` directly from JWT claims, separate from `session.person`. This is load-bearing for logout: if the person isn't seeded in the public store (dev with no data), person lookup returns null but the jti still needs to be revoked using the sub from the JWT. Routes that only need the person ID should prefer `session.personId`.
- **gitsheets Sheet snapshot**: The `Sheet` object captures the data tree at `openStore()` call time. Reads via `sheet.queryFirst()` always use the snapshot from app boot; new commits to the repo aren't visible until the app restarts. This is intentional and consistent with the load-at-boot model.
- **Private store `readBlob`/`writeBlob`**: Extended the `PrivateStore` interface with generic blob read/write for the session-metadata JSON. This is a thin wrapper over the existing `readRaw`/`writeRaw` in the base class.

## Follow-ups

- Deferred to [github-oauth](github-oauth.md) — implement the actual GitHub OAuth flow replacing the 501 stubs at `/api/auth/github/start` and `/api/auth/github/callback`.
