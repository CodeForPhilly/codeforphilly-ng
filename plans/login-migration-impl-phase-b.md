---
status: done
depends: [login-migration-impl-phase-a]
specs:
  - specs/api/auth.md
  - specs/screens/login.md
issues: []
pr: 119
---

# Plan: login-migration impl — phase B (POST /api/auth/login + /api/auth/me updates + SPA secondary form)

## Scope

Second phase of the [login-migration-strategy](./login-migration-strategy.md) implementation track. Wires the phase-A verifier into a real login endpoint, adds the new `/api/auth/me` fields, and surfaces the SPA's secondary password form.

What ships:

- **`POST /api/auth/login`** — verifies via `verifyLegacyPassword`, rotates the credential on success (rehash + `lastUsedAt`), mints a session with `loginMethod: 'legacy_password'`.
- **`PrivateStore.putLegacyPassword`** — added so the login route can write back rotated credentials. Wired through the cross-store transaction's staged-mutation set.
- **JWT `loginMethod` claim** — optional claim on both access and refresh tokens. Preserved across refresh.
- **`/api/auth/me`** returns `hasGitHubLink` + `lastLoginMethod`.
- **GitHub OAuth callback** passes `loginMethod: 'github'` when minting.
- **SPA `/login`** — secondary collapsed "Or sign in with your Code for Philly password" disclosure that POSTs to `/api/auth/login`. "Returning member" copy updated to match the new spec.

## Implements

- [api/auth.md](../specs/api/auth.md) — `POST /api/auth/login` endpoint + `/api/auth/me` field additions.
- [screens/login.md](../specs/screens/login.md) — secondary password form (the "Forgot your password?" affordance is deferred to phase C).
- [behaviors/account-migration.md](../specs/behaviors/account-migration.md) — the three-paths sign-in story: GitHub-new, GitHub-matched, legacy-password.
- [behaviors/password-hash-rotation.md](../specs/behaviors/password-hash-rotation.md) — wired into the route, not just the verifier.

## Approach

### 1. `POST /api/auth/login` route

In `apps/api/src/routes/auth.ts`, inserted before `/api/auth/refresh`. Body validated as `{ usernameOrEmail, password }`. Pipeline:

1. Resolve `usernameOrEmail.toLowerCase()` against `personIdBySlug`, then `findPersonIdByEmail` if the value contains `@`.
2. Anti-enumeration: on miss (no resolved person, no person record, no credential), call `dummyVerify()` and 401.
3. Verify via `verifyLegacyPassword` from phase A.
4. On `valid: true`: rotate the credential (rehash if `needsRehash`; always refresh `lastUsedAt`). Write back via `putLegacyPassword`.
5. Mint session with `loginMethod: 'legacy_password'`, persist session metadata, set cookies, return `{ person }`.

Rate-limit cap already covers this path via the existing `/api/auth/*` 10/min/IP bucket.

### 2. `PrivateStore.putLegacyPassword`

Existing private store had `deleteLegacyPassword` (used by the claim flow) but no put. Added to the interface, the base impl, and the cross-store transaction's staged-mutation set. Conflicting puts/deletes within a single transaction follow the existing pattern (later op wins on the same key).

### 3. JWT `loginMethod` claim

`issueSession` takes an optional `loginMethod`. The value is encoded on both access and refresh tokens. `verifyAccess` and `verifyRefresh` surface it via `AccessClaims.loginMethod` / `RefreshClaims.loginMethod`. The refresh route preserves the claim through token rotation. Existing sessions (issued before this PR) have no claim — verifier returns the claim object without the field, the SPA reads `null`.

### 4. `/api/auth/me`

Adds two fields:

- `hasGitHubLink: boolean` — derived from `Person.githubUserId !== null`. False for anonymous.
- `lastLoginMethod: 'github' | 'legacy_password' | 'password_reset' | null` — pulled from the current access token's `loginMethod` claim.

Existing callers parsing only `{ person, accountLevel }` are unaffected.

### 5. SPA `/login`

The existing `LoginPlaceholder.tsx`:

- Updates the "Returning member" copy to match the new spec ("you can sign in with your old password below — or use GitHub if your old email matches")
- Adds a collapsed `LegacyPasswordLogin` component below the GitHub CTA. Click the disclosure → form expands with `usernameOrEmail` + `password` + submit. On success: `navigate(returnPath ?? '/')`.
- Inline error rendering for 401 (uniform "username or password is incorrect") and 429.

"Forgot your password?" is deliberately deferred to phase C — needs the email-token plumbing which lives in `PasswordToken` / `password-reset/{request,confirm}` routes.

### 6. Tests

- **`apps/api/tests/auth-login.test.ts` (new)** — 12 cases: SHA-1/argon2 happy paths, email resolution, GitHub-linked user, rehash-on-login, no-rotate-when-current, all four 401 paths (wrong password, unknown user, unknown email, missing body), `/api/auth/me` post-login fields (legacy_password + hasGitHubLink false), GitHub-linked /api/auth/me (legacy_password + hasGitHubLink true), anonymous /api/auth/me.
- **`apps/web/tests/LoginPlaceholder.test.tsx` (new)** — 4 cases: GitHub button + collapsed disclosure render, disclosure expands to reveal fields, submit gated until both fields filled, inline 401 error.

## Validation

- [x] `POST /api/auth/login` returns 200 with the Person on correct credentials and 401 `invalid_credentials` on any failure.
- [x] Rehash-on-login rotates SHA-1 → argon2id; leaves already-argon2id-with-current-params unchanged but refreshes `lastUsedAt`.
- [x] `/api/auth/me` returns `hasGitHubLink` + `lastLoginMethod` (`null` for anonymous, `'legacy_password'` after password login, `'github'` after OAuth — verified via the github-oauth path).
- [x] JWT `loginMethod` claim persists across refresh.
- [x] SPA login form is collapsed by default, expands on click, submits + handles 401/429 inline.
- [x] `npm run type-check && npm run lint` clean.
- [x] 12 new API tests pass; 4 new web tests pass; full sweep validated separately.

## Risks / unknowns

- **Cross-store transaction surface widened.** `PrivateStoreTx` gains `putLegacyPassword`. The login route uses the direct `putLegacyPassword` method (not the transaction wrapper) since it doesn't need cross-store atomicity. The transaction path is exercised by other future callers (password-reset's confirm route will use it).
- **Older sessions without `loginMethod` claim.** Pre-PR sessions report `lastLoginMethod: null`. The SPA banner state for these is benign — they're GitHub-linked sessions (the only kind issued before this PR), so `hasGitHubLink: true` and the banner stays hidden.
- **Concurrent login + refresh race.** A user logs in, then the SPA fires a refresh at the same moment. The refresh route's `await verifyRefresh` doesn't know about the new session yet. Both end up with valid sessions — fine, the old one expires in 15m. No corruption.
- **Lockout from too-many-fails.** The 10/min/IP cap protects against brute-force from a single source. NAT'd users sharing an IP could hit it; the spec accepts this trade-off (alternative is per-account locking which is its own can of worms).

## Notes

Two commits: plan-open (this file at status: in-progress) + the impl. Actually one — given the spec is already locked, decided to write the plan with the work already done and ship as a single feat commit with the closeout in place.

Surprises:

- **`PrivateStoreTx` only had a put for profiles, not credentials.** Easy to add but required threading through the cross-store `StoreTx` wrapper too. Worth noting because future tx surface additions (e.g., the `PasswordToken` private record in phase C) will follow the same pattern: interface → base.transact stage set → store.transact stage set.
- **`setSessionCookies` takes nodeEnv as a third arg.** Not obvious from the function name; the parameter switches between Secure-flag-on vs. off based on `NODE_ENV`. Easy to miss for the first caller (caught by TS at type-check). Worth not refactoring — the explicit threading is clearer than implicit fastify-config access.
- **JWT claim is optional throughout.** `loginMethod` not in the type union (existing sessions don't have it). The verifier explicitly type-narrows when the value is one of the known strings; everything else returns the claim object without the field. Forward-compatible.
- **Web `parseSessionCookie` helper.** The test infra returns `Set-Cookie` headers as a string or string-array. The integration test for `/api/auth/me` post-login parses out the `cfp_session=...` portion manually since the test agent doesn't auto-attach cookies across inject calls.

## Follow-ups

- **Phase C — password reset.** `POST /api/auth/password-reset/{request,confirm}` + `PasswordToken` private record + email-notifier integration + SPA "Forgot your password?" flow. *Deferred to plan* — `plans/login-migration-impl-phase-c.md`.
- **Phase D — link-github.** `POST /api/auth/link-github` + link-mode OAuth callback variant + `/account` banner + SPA flow. *Deferred to plan* — `plans/login-migration-impl-phase-d.md`.
- **Coverage report.** `lastUsedAt` is now populated; a future small script can report "X% of active password users have linked GitHub" to inform sunset timing. *None* — wait for the data to mean something.
