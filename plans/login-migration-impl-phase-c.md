---
status: done
depends: [login-migration-impl-phase-b]
specs:
  - specs/api/auth.md
  - specs/behaviors/account-migration.md
  - specs/behaviors/password-hash-rotation.md
issues: []
pr: 120
---

# Plan: login-migration impl — phase C (password reset)

## Scope

Third phase of the [login-migration-strategy](./login-migration-strategy.md) implementation track. Adds email-token-based password recovery for legacy-credential accounts, plus the SPA affordance that gets users into the flow.

What ships:

- **`PasswordToken` private record** — one-time, SHA-256-hashed, 1-hour expiry. The plaintext token leaves the system only via the email send; the store only ever holds the hash.
- **`POST /api/auth/password-reset/request`** — always 202, fire-and-forget notifier send, anti-enumeration silent no-op when target is unresolvable / has no email / has no credential.
- **`POST /api/auth/password-reset/confirm`** — single-use token, uniform 401 on all rejection paths, rehashes new password to argon2id, rotates the credential, mints a session with `loginMethod: 'password_reset'`.
- **`EmailNotifier.notifyPasswordReset`** + LoggingNotifier impl + email template (text + HTML).
- **SPA** — "Forgot your password?" link on the legacy-password form, `/login/forgot` request page, `/login/reset?token=...` confirm page.

## Implements

- [api/auth.md](../specs/api/auth.md) — both password-reset endpoints + the `PasswordToken` data shape.
- [behaviors/account-migration.md](../specs/behaviors/account-migration.md) — recover-by-email path.
- [behaviors/password-hash-rotation.md](../specs/behaviors/password-hash-rotation.md) — reset target rehashes to argon2id at current params (same `rehashPassword` from phase A).

## Approach

### 1. `PasswordToken` schema + private-store wiring

- New Zod schema at `packages/shared/src/schemas/password-token.ts`: `{ tokenHash, personId, issuedAt, expiresAt, usedAt }`. `tokenHash` is the SHA-256 hex of the plaintext.
- `BasePrivateStore` adds a `passwordTokens: Map<string, PasswordToken>` keyed by `tokenHash`, with `load() → readRaw('password-tokens.jsonl')` + `flushPasswordTokens()` mirroring the existing record types.
- `PrivateStore` interface adds `getPasswordToken`, `putPasswordToken`, `deletePasswordToken`. Not added to `PrivateStoreTx` — both routes call the direct methods (no cross-store atomicity needed).
- `parseJsonl` keyField type extended to include `'tokenHash'` since tokens are keyed by their hash, not `personId` or `id`.

### 2. Notifier integration

- `Notifier` interface gains `notifyPasswordReset(n: PasswordResetNotification): Promise<{ delivered: boolean }>`. Shape: `{ email, fullName, slug, token, expiresAt }`.
- `LoggingNotifier` impl logs `{ slug, email, expiresAt }` but **never** the token. Even in dev logs, plaintext password-reset tokens stay out of any persisted log stream.
- `EmailNotifier` impl mirrors `notifyWelcomeOnSignup` — Resend `emails.send` with `from`/`to`/`subject`/`text`/`html`; log on send / failure / throw; never throws to the caller.
- `renderPasswordResetEmail` builds the URL `https://${host}/login/reset?token=<encoded>`, subject `"Reset your Code for Philly password"`, body mentions 1-hour expiry + GitHub-sign-in alternative.

### 3. `POST /api/auth/password-reset/request`

Inserted after `/api/auth/login` in `apps/api/src/routes/auth.ts`. Pipeline:

1. Resolve `usernameOrEmail` via `personIdBySlug`, then `findPersonIdByEmail` (same convention as `/login`).
2. Look up `person`, `cred` (legacy password), `profile`. Silent no-op (still 202) when:
   - Person doesn't resolve / is deleted, OR
   - No legacy credential (so password-reset can't *create* a credential — spec invariant), OR
   - No email on file.
3. Generate `randomBytes(32).toString('base64url')` as the plaintext, SHA-256 it for `tokenHash`, persist `PasswordToken` with 1-hour `expiresAt`.
4. Fire-and-forget `notifier.notifyPasswordReset({ email, fullName, slug, token: plaintext, expiresAt })` with a `.catch(log)` — never block the response on notifier latency.
5. Always reply `202 { delivered: true }`.

Rate-limit cap covered by the existing `/api/auth/*` 10/min/IP global bucket.

### 4. `POST /api/auth/password-reset/confirm`

Pipeline:

1. Body validated as `{ token, password }` with `password.minLength: 8` enforced at the schema layer (Fastify returns 422 `validation_failed` automatically).
2. SHA-256 the supplied `token` → lookup `PasswordToken` by hash. Reject (401 `invalid_token`) if missing, expired (`expiresAt <= now`), or already used (`usedAt != null`).
3. Look up the person. Reject same 401 if missing/deleted.
4. Look up the existing `LegacyPasswordCredential`. Reject same 401 if absent — per spec, password-reset never *creates* a credential for a person who doesn't already have one.
5. `rehashPassword(password)` → argon2id at current params.
6. `putLegacyPassword({ ...existing, passwordHash: newHash, lastUsedAt: now })`.
7. Mark `PasswordToken.usedAt = now` via `putPasswordToken`.
8. Mint session with `loginMethod: 'password_reset'`, persist session metadata, set cookies, 200 `{ person }`.

Every error path collapses to a uniform 401 with `error.code = "invalid_token"` so timing + response shape can't distinguish "unknown token" from "expired token" from "no credential."

### 5. SPA

- **`api.auth.passwordResetRequest(usernameOrEmail)`** + **`api.auth.passwordResetConfirm(token, password)`** added to `apps/web/src/lib/api.ts`.
- **`LoginPlaceholder`** — "Forgot your password?" `<Link to="/login/forgot">` added below the legacy-password submit button.
- **`PasswordResetRequest` (new, `/login/forgot`)** — single-input form. On submit: call the request endpoint, swap to a generic "If we have an account on file matching <input>, we just sent a reset link" confirmation panel regardless of outcome (anti-enumeration is the server's job, but the SPA mirrors the contract).
- **`PasswordResetConfirm` (new, `/login/reset?token=...`)** — two password fields. Validates match + minimum length client-side. On submit: call confirm, then `reload()` auth, then navigate to `/`. Error handling for 401 (`"this reset link is invalid or has expired"`), 422, 429.
- **`App.tsx`** — wires `/login/forgot` + `/login/reset`.

### 6. Tests

- **`apps/api/tests/auth-password-reset.test.ts` (new)** — 13 cases: anti-enumeration (unknown user / no-cred / no-email all 202 silent), happy path (token persisted + correct expiry + 1-hour window), email resolution, four 401 paths on confirm (unknown / expired / used / no-credential), 422 for short password, end-to-end happy path (cookies + credential rotated to argon2id + token marked used + verifyLegacyPassword roundtrip), single-use enforcement, end-to-end with `/api/auth/login` post-reset.
- **`apps/web/tests/PasswordReset.test.tsx` (new)** — 5 cases: request form disabled when empty, request shows generic confirmation after submit, confirm warns when token missing, confirm blocks mismatched passwords, confirm renders friendly invalid-token error on 401.

## Validation

- [x] `POST /api/auth/password-reset/request` returns 202 in all branches; persists `PasswordToken` only when target resolves with email + credential.
- [x] `POST /api/auth/password-reset/confirm` rotates credential to argon2id, marks token used, mints session with `loginMethod: 'password_reset'`; uniform 401 on every rejection path.
- [x] Single-use enforced: same token returns 401 on second submit.
- [x] New password verifies through `verifyLegacyPassword`; the old password no longer does.
- [x] SPA `/login/forgot` flow renders + submits + shows generic confirmation.
- [x] SPA `/login/reset?token=...` flow validates client-side + handles 401/422/429.
- [x] `npm run type-check && npm run lint` clean.
- [x] 13 new API tests pass; 5 new web tests pass; full sweep validated separately.

## Risks / unknowns

- **Notifier latency hides delivery failures.** Fire-and-forget means a Resend outage leaves the user staring at "we sent a link" with no link arriving. Acceptable v1 — the spec calls out the always-202 contract — but worth a future ops follow-up: a periodic "tokens issued without delivery confirmation" log query.
- **Token format in URL leaks via referer.** The token rides in the query string of `/login/reset?token=...`. If the user clicks any external link from that page before submitting, the referer header could leak it. Mitigations: the page is server-rendered with no external links, but a paranoid future change could swap to URL-fragment encoding + a tiny JS fish-it-out shim. Not v1 work.
- **No per-email rate-limit on `/request`.** Global IP cap (10/min) is fine for casual abuse; a determined attacker on a botnet could probe many emails. Punted per "who cares" decision in the strategy thread — revisit only if abuse signals appear.
- **Tokens accumulate on disk.** No cleanup of expired tokens. The store is in-memory + flushed-on-write; for civic-scale this is fine for years, but a future `cleanup-expired-password-tokens.ts` script would be cheap insurance.

## Notes

Shipped clean — all 13 API tests + 5 web tests pass on first full sweep. Type-check + lint green.

Surprises:

- **Test seed-via-disk doesn't work after app boot.** First pass of `mintToken` in the confirm tests wrote tokens directly to `password-tokens.jsonl`. The route then 401'd because the in-memory map (loaded at boot) didn't see the post-boot file writes. Switched to `app.store.private.putPasswordToken(...)` which updates both. Worth remembering: any test seeding *after* `buildTestApp` must go through the store API, not direct file writes — only pre-boot seeds work as JSONL appends.
- **`getByLabelText(/new password/i)` matched two labels.** Both "New password" and "Confirm new password" matched the partial regex, throwing a "multiple elements found" error. Fixed with `^...$` anchors. A general lesson for forms with overlapping labels — RTL's default substring match needs explicit boundaries when label text is a prefix of another.
- **Token plaintext stays out of every log path.** `LoggingNotifier.notifyPasswordReset` deliberately logs slug + email + expiresAt but never the token, even though the dev log is the easy debug surface. Trade-off: if the email send fails silently, the dev has to re-trigger the flow to get a working token rather than fishing one from the logs. Worth it — the rule "plaintext tokens only appear over the email channel" is one of those security properties that's easy to define and hard to claw back if violated.
- **Token expiry check uses `<=` not `<`.** A token whose `expiresAt` equals `now` is treated as expired. Boundary chosen to avoid a 1ms race window where the schema timestamp says expired but the comparison says valid.

## Follow-ups

- **Phase D — link-github.** `POST /api/auth/link-github` + link-mode OAuth callback variant + `/account` banner + SPA flow. *Deferred to plan* — `plans/login-migration-impl-phase-d.md`.
- **Expired-token cleanup.** A periodic prune of `password-tokens.jsonl` entries past expiry. *None* — tokens are tiny; revisit if disk pressure ever shows up.
- **Per-target-email rate-limit on `/request`.** Future hardening if abuse signals appear. *None.*
- **Token in URL fragment instead of query.** Defense against referer-leak. *None* — not a v1 concern given the page has no external links.
