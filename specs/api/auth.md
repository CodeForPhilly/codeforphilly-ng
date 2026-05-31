# API: Authentication

Two primary sign-in paths:

1. **GitHub OAuth** — the only path for new accounts. Pre-cutover laddr users who match a verified GitHub email also use this path (auto-link, no claim ceremony).
2. **Legacy password** — `POST /api/auth/login` for pre-cutover laddr users who remember their old credentials. Sessions are minted exactly as for GitHub sign-in. Per [behaviors/account-migration.md](../behaviors/account-migration.md).

Sessions are stateless JWTs (per [behaviors/authorization.md](../behaviors/authorization.md)).

Account creation (sign-up) is GitHub-only — there is no `/api/auth/register` endpoint, per [deferred.md](../deferred.md).

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/auth/github/start` | public | Begin GitHub OAuth flow. Redirects to GitHub. |
| `GET` | `/api/auth/github/callback` | public | OAuth callback. Exchanges code for tokens, resolves identity, issues session or routes to claim flow. |
| `POST` | `/api/auth/login` | public | Legacy password sign-in. Rehashes on success per [password-hash-rotation.md](../behaviors/password-hash-rotation.md). |
| `POST` | `/api/auth/password-reset/request` | public | Request a one-time password-reset link to the email on file. |
| `POST` | `/api/auth/password-reset/confirm` | public (token) | Complete a password reset using the emailed token. |
| `POST` | `/api/auth/link-github` | user | Start a GitHub OAuth round-trip to bind a GitHub identity to the current Person. Used by the `/account` "Connect GitHub" banner. |
| `GET` | `/api/auth/me` | public (with optional session) | Returns current Person + accountLevel + `hasGitHubLink` + `lastLoginMethod`, or anonymous. |
| `POST` | `/api/auth/refresh` | refresh-cookie | Mint a new access+refresh pair. |
| `POST` | `/api/auth/logout` | user | End the current session. |
| `GET` | `/api/auth/sessions` | user | List remembered sessions. |
| `POST` | `/api/auth/sessions/:jti/revoke` | user (self) | Revoke a specific session. |

The account-claim helpers (`/api/account-claim/*`) cover the rare "I have a duplicate account, merge it" case — see [api/account-claim.md](account-claim.md) and [behaviors/account-migration.md](../behaviors/account-migration.md). They are no longer a gate at first sign-in.

## GET /api/auth/github/start

Initiates the GitHub OAuth flow.

### Query parameters

| Param | Required | Notes |
| ----- | -------- | ----- |
| `return` | no | Same-origin path to navigate to after successful sign-in. URL-encoded. Ignored if not same-origin. Defaults to `/`. |

### Behavior

1. Generate a CSRF state token (32 bytes CSPRNG, base64url), store in a short-lived (10 min) HttpOnly cookie `cfp_oauth_state`
2. Generate a one-time PKCE code verifier (per [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)); compute the code challenge
3. Persist `{ state, codeVerifier, return }` in a short-lived (10 min) signed cookie `cfp_oauth_session` (signed with the JWT signing key, not encrypted — it doesn't carry secrets needing confidentiality)
4. Redirect the browser to:

   ```text
   https://github.com/login/oauth/authorize
     ?client_id=<GITHUB_OAUTH_CLIENT_ID>
     &redirect_uri=https://codeforphilly.org/api/auth/github/callback
     &scope=read:user user:email
     &state=<state>
     &code_challenge=<challenge>
     &code_challenge_method=S256
   ```

The `read:user user:email` scope set is the minimum: profile + verified emails. We do not request `repo` or anything else.

### Errors

- `400 bad_request` — invalid `return` URL (not same-origin, malformed) → ignored and replaced with `/`. Not a hard error.

## GET /api/auth/github/callback

Handles the OAuth callback after the user authorizes (or denies) on GitHub.

### Query parameters

| Param | From GitHub | Notes |
| ----- | ----------- | ----- |
| `code` | success | OAuth authorization code |
| `state` | success | CSRF state echo |
| `error` | failure | GitHub error code (e.g., `access_denied`) |
| `error_description` | failure | Human-readable error |

### Behavior

1. **Validate state.** Compare `state` query param against the `cfp_oauth_state` cookie. Mismatch → `401` with `error.code = "oauth_state_mismatch"`. Clear the cookie either way.
2. **Validate cfp_oauth_session.** Verify signature, extract `{ codeVerifier, return }`. Tampered → `401`. Clear the cookie.
3. **Handle denial.** If `error` is present (`access_denied`, etc.): redirect to `/login?error=<error>` so the SPA can render a friendly message.
4. **Exchange code for tokens.** POST `https://github.com/login/oauth/access_token` with `client_id`, `client_secret`, `code`, `code_verifier`. Get back an access token.
5. **Fetch user identity.** GET `https://api.github.com/user` with the access token → `{ id, login, name, ... }`. GET `https://api.github.com/user/emails` → `[{ email, primary, verified }, ...]`.
6. **Resolve identity to a Person** — see [behaviors/account-migration.md](../behaviors/account-migration.md) for the matching algorithm. Outcome is one of:
   - **a) Existing linked Person** (`Person.githubUserId === gh.id`). Refresh `Person.githubLogin`, update `PrivateProfile.email` to the latest GitHub primary verified email, issue session, redirect to `return`.
   - **b) New Person needed, no legacy match.** Create a fresh `Person` + `PrivateProfile`, link the GitHub identity, issue session, redirect.
   - **c) Legacy candidate(s) found.** Issue a short-lived **claim-pending JWT** (5 minutes, scope `claim`) and redirect to `/account-claim?candidates=...`. The user confirms or declines, finalizing identity via [api/account-claim.md](account-claim.md).

### Response

In every successful case the user is redirected to either `return` (validated same-origin) or `/account-claim`. The redirect carries `Set-Cookie` headers for the session JWTs (cases a, b) or for the claim-pending JWT (case c).

### Errors

- `401 unauthenticated` with code `oauth_state_mismatch` — CSRF failure
- `401 unauthenticated` with code `oauth_session_invalid` — signed-session cookie tampered/expired
- `502 bad_gateway` with code `github_unreachable` — GitHub API call failed; user redirected to `/login?error=github_unreachable`
- `403 forbidden` with code `email_unverified` — GitHub returned no verified email (user has email visibility off AND no verified primary); user redirected to `/login?error=email_unverified` with a help message about GitHub email visibility

## POST /api/auth/login

Legacy password sign-in. Open to any user with a `LegacyPasswordCredential` on file. Per [behaviors/account-migration.md](../behaviors/account-migration.md) and [behaviors/password-hash-rotation.md](../behaviors/password-hash-rotation.md).

### Request

```json
{
  "usernameOrEmail": "jane",
  "password": "<plaintext>"
}
```

`usernameOrEmail` is resolved against `Person.slug` first, then `PrivateProfile.email`.

### Behavior

1. Resolve `usernameOrEmail` to a Person; if unresolved, run a dummy argon2 verify against a fixed plaintext (anti-enumeration timing floor) and 401.
2. Load `LegacyPasswordCredential` for the Person; if absent, same dummy-verify-then-401.
3. Detect hash algorithm by format; verify per [password-hash-rotation.md](../behaviors/password-hash-rotation.md).
4. On success: **rehash** the supplied password to argon2id with current params, overwrite the credential record (`passwordHash`, `lastUsedAt = now`), mint an access+refresh JWT pair, set cookies, 200.
5. On failure: 401, uniform error code, no algorithm or user-existence leak.

### Response — 200

```json
{ "success": true, "data": { "person": { /* PersonResponse */ } } }
```

Plus `Set-Cookie` headers for `cfp_session` and `cfp_refresh`.

### Errors

- `401 unauthenticated` with `error.code = "invalid_credentials"` — covers no-such-user, wrong-password, unknown-hash-format. Single response, comparable timing across cases.
- `429 too_many_requests` — per the auth-endpoint rate cap (10/min/IP) in [api/conventions.md](conventions.md).

## POST /api/auth/password-reset/request

Initiates a password reset by emailing a one-time signed token to the address in `PrivateProfile.email`.

### Request

```json
{ "usernameOrEmail": "jane@example.com" }
```

### Behavior

1. Resolve to a Person; if unresolved or no email on file, do nothing (no enumeration).
2. Mint a `PasswordToken` (private-store record, 1-hour expiry, single-use) with `personId` + a CSPRNG token.
3. Send an email to `PrivateProfile.email` containing the link `https://<host>/login/reset?token=<token>`.

### Response — 202

```json
{ "success": true, "data": { "delivered": true } }
```

Always 202, regardless of whether the email actually resolved or sent. The body is informational; the *real* signal is that the user receives (or doesn't receive) the email.

### Errors

- `429 too_many_requests` — same 10/min/IP cap as `/api/auth/login`.

## POST /api/auth/password-reset/confirm

Completes a password reset using a token from the email link.

### Request

```json
{
  "token": "<opaque from email>",
  "password": "<new plaintext>"
}
```

### Behavior

1. Look up the `PasswordToken`; reject expired, used, or unknown tokens (401 uniform).
2. Hash the new password with argon2id (current params).
3. Overwrite the Person's `LegacyPasswordCredential.passwordHash`, set `lastUsedAt = now`.
4. Mark the `PasswordToken` as used.
5. Mint an access+refresh JWT pair (the reset doubles as a sign-in), set cookies, 200.

### Response — 200

Same shape as `POST /api/auth/login`.

### Errors

- `401 unauthenticated` with `error.code = "invalid_token"`
- `422 validation_failed` if the new password violates the minimum policy (≥ 8 chars at v1 — TBD with the implementation PR)

## POST /api/auth/link-github

Binds a GitHub identity to the currently-signed-in Person. Initiates a GitHub OAuth round-trip; the callback at `/api/auth/github/callback` recognizes the "link" mode (signed-session cookie carries a `link` scope tag) and finalizes the link rather than minting a new session.

### Request

Empty body. The flow is purely redirect-driven.

### Behavior

1. The route sets a short-lived signed cookie (`cfp_oauth_session`) with `mode = 'link'` and the current `personId`, then redirects to GitHub OAuth (same `?return=...` mechanics as `/api/auth/github/start`).
2. The callback verifies the OAuth result. If `Person.githubUserId` is already set on the linking Person: `409 github_already_linked`. If the GitHub `id` is bound to a *different* Person: `409 github_id_in_use_elsewhere` (resolved by admin merge, not self-service).
3. Otherwise: set `Person.githubUserId = gh.id`, `Person.githubLogin = gh.login`, `Person.githubLinkedAt = now`. Refresh `PrivateProfile.email` to the GitHub primary verified email **only if the user consents** at the link-confirmation screen (toggle defaults to "keep current email").
4. Redirect to `?return` or `/account`.

### Response

302 redirect to GitHub; then 302 back to `?return` or `/account` after the callback.

### Errors (rendered as `/account?error=<code>` after the callback)

- `github_already_linked` — caller already has a GitHub link
- `github_id_in_use_elsewhere` — another Person already owns this `gh.id`
- `oauth_state_mismatch`, `oauth_session_invalid`, `github_unreachable` — same as `/api/auth/github/start`

## GET /api/auth/me

Returns the current Person (full PersonResponse shape — see [api/people.md](people.md)) plus `accountLevel`, `hasGitHubLink`, and `lastLoginMethod`. Used by the SPA on load to bootstrap the auth context and decide whether to render the "Connect GitHub" banner.

### Response — 200

```json
{
  "success": true,
  "data": {
    "person": { /* PersonResponse */ },
    "accountLevel": "staff",
    "hasGitHubLink": true,
    "lastLoginMethod": "github"
  }
}
```

`hasGitHubLink` is `Person.githubUserId !== null`. `lastLoginMethod` is one of `"github" | "legacy_password" | "password_reset"`; the SPA can use it to render UI hints (e.g., "Signed in via password — connect GitHub for faster sign-in next time" inline on `/account`).

If no session, returns 200 with `data.person = null`, `data.accountLevel = "anonymous"`, `hasGitHubLink = false`, `lastLoginMethod = null`. (We deliberately do not 401 here — the frontend calls this on every page load including public pages.)

The PersonResponse for self includes `email` (fetched from PrivateProfile) and `newsletter` state. For staff viewing other people, see [api/people.md](people.md) on which private fields are visible.

## POST /api/auth/refresh

Mints a new access+refresh JWT pair from a valid refresh JWT. Implementation unchanged from the earlier Phase 1 spec.

### Response — 200

Empty body. Sets fresh `cfp_session` and `cfp_refresh` cookies.

### Errors

- `401 unauthenticated` with `error.code = "refresh_token_expired"`
- `401 unauthenticated` with `error.code = "refresh_token_revoked"`
- `401 unauthenticated` with `error.code = "no_refresh_token"`

## POST /api/auth/logout

Revokes the current access + refresh JWT `jti`s (writes to the `revocations` sheet — see [data-model.md#revocation](../data-model.md#revocation)) and clears the session cookies.

### Response — 204

## GET /api/auth/sessions

Lists remembered sessions (non-revoked refresh-token `jti`s with side-channel metadata). See [behaviors/authorization.md](../behaviors/authorization.md) for the "what's a session" framing.

### Response — 200

```json
{
  "success": true,
  "data": [
    {
      "jti": "<uuidv7>",
      "userAgent": "Mozilla/5.0 ...",
      "ipAddress": "1.2.3.4",
      "issuedAt": "...",
      "expiresAt": "...",
      "current": true
    }
  ]
}
```

Note: `userAgent` and `ipAddress` here come from the in-memory session-metadata map, which is populated at JWT issue time and persists across restarts via a small sidecar in the private bucket. They are **never** included in commit trailers on the public repo — see [behaviors/storage.md](../behaviors/storage.md#pii-aware-redaction).

## POST /api/auth/sessions/:jti/revoke

Revokes a non-current session by `jti`. Unchanged from Phase 1.

### Response — 204

### Errors

- `404 not_found` — `jti` doesn't match a session we have metadata for (or doesn't belong to caller)
- `409 conflict` with `error.code = "cannot_revoke_current_session"`

## Notes

- **Sign-up is GitHub-only.** `/api/auth/register` does not exist; trying to call it returns `404 not_found`. New accounts are only created through the GitHub OAuth callback's "no legacy match" branch.
- **Password sign-in is for migrated users only.** `POST /api/auth/login` accepts any user with a `LegacyPasswordCredential` on file. Records are populated from the laddr import; no rewrite-code path *creates* a new credential except via `POST /api/auth/password-reset/confirm` for an existing record.
- **Every successful password sign-in rehashes** the supplied plaintext to argon2id per [password-hash-rotation.md](../behaviors/password-hash-rotation.md). Laddr's unsalted SHA-1 drifts toward modern hashing without user action.
- **GitHub identity is immutable per Person, once set.** A self-service "unlink GitHub" flow is not v1. If a user loses access to their GitHub account, they can fall back to password sign-in if they remember it, then `password-reset` from their email-on-file. If both are dead, recovery is staff-mediated.
- **Email is GitHub-sourced when linked.** Once a Person has a GitHub link, `PrivateProfile.email` is refreshed on every successful OAuth callback to the user's current primary verified GitHub email. Password-only users keep whatever email was imported from laddr; they don't have a self-service "change email" UI.
- **The OAuth state cookie expires aggressively** (10 minutes) so abandoned flows don't accumulate.
- **PKCE is required** even though we have a client secret on the server — PKCE protects against authorization-code interception in addition to whatever client-secret protection we already have.
