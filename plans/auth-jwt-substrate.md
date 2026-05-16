---
status: in-progress
depends: [api-skeleton]
specs:
  - specs/api/auth.md
  - specs/behaviors/authorization.md
issues: []
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

HS256 with `CFP_JWT_SIGNING_KEY`. Access JWT: 15 min, `{ sub: personId, jti, accountLevel, exp, iat }`. Refresh JWT: 30 days, `{ sub: personId, jti, exp, iat }`. Claim-pending JWT: 5 min, `{ sub: ghId, scope:'claim', candidates, ghLogin, ghName, ghEmails, exp, iat }`.

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

- [ ] `mintSessionFor(personId)` issues valid access + refresh JWTs that the verifier accepts
- [ ] `GET /api/auth/me` with a valid `cfp_session` returns the person + accountLevel
- [ ] `GET /api/auth/me` with no cookie returns `{person:null, accountLevel:'anonymous'}`, 200
- [ ] Expired access JWT → 401 `access_token_expired`
- [ ] `POST /api/auth/refresh` with valid refresh JWT returns new pair; revoked refresh JWT → 401 `refresh_token_revoked`
- [ ] `POST /api/auth/logout` revokes both jtis and clears cookies; subsequent `/api/auth/me` returns anonymous
- [ ] `GET /api/auth/sessions` lists non-revoked sessions with metadata; current session marked `current:true`
- [ ] `POST /api/auth/sessions/:jti/revoke` with `:jti` == current's returns 409 `cannot_revoke_current_session`
- [ ] Revocation sweeper deletes expired `revocations` records
- [ ] Account-based rate limits wired: authenticated reads key on `account:<personId>` (300/min), writes key on `write-account:<personId>` (30/min) — update `apps/api/src/plugins/rate-limit.ts` to use `request.session.person` (deferred from api-skeleton)
- [ ] OAuth endpoints return 501 `oauth_not_yet_wired` (placeholder)
- [ ] Tests cover all of the above using `mintSessionFor` + `createTestRepo` + `createTestPrivateStore`

## Risks / unknowns

- **Claim-pending JWT scope enforcement.** A `cfp_claim` cookie present on a non-claim route must be ignored (not accidentally honored as `cfp_session`). The middleware strictly separates the two by cookie name + scope claim.
- **Clock skew between issue and verify.** Tolerate ±60s; explicit in the JWT library config.
- **Session metadata in the private bucket** is a small write per session-issue; bucket PUTs are atomic so concurrent issues serialize naturally through the private-store mutex.

## Notes
