# API: Authentication

GitHub OAuth is the sole primary auth method. Sessions are stateless JWTs (per [behaviors/authorization.md](../behaviors/authorization.md)). Email/password sign-in does not exist — see [deferred.md](../deferred.md).

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/auth/github/start` | public | Begin GitHub OAuth flow. Redirects to GitHub. |
| `GET` | `/api/auth/github/callback` | public | OAuth callback. Exchanges code for tokens, resolves identity, issues session or routes to claim flow. |
| `GET` | `/api/auth/me` | public (with optional session) | Returns current Person + accountLevel, or anonymous. |
| `POST` | `/api/auth/refresh` | refresh-cookie | Mint a new access+refresh pair. |
| `POST` | `/api/auth/logout` | user | End the current session. |
| `GET` | `/api/auth/sessions` | user | List remembered sessions. |
| `POST` | `/api/auth/sessions/:jti/revoke` | user (self) | Revoke a specific session. |

The account-claim flow (`/api/account-claim/*`) is documented in [api/account-claim.md](account-claim.md). It's invoked from `/api/auth/github/callback` when the OAuth identity doesn't match an existing linked Person but matches a legacy candidate.

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

## GET /api/auth/me

Returns the current Person (full PersonResponse shape — see [api/people.md](people.md)) plus `accountLevel`. Used by the SPA on load to bootstrap the auth context.

### Response — 200

```json
{
  "success": true,
  "data": {
    "person": { /* PersonResponse */ },
    "accountLevel": "staff"
  }
}
```

If no session, returns 200 with `data.person = null` and `data.accountLevel = "anonymous"`. (We deliberately do not 401 here — the frontend calls this on every page load including public pages.)

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

Note: `userAgent` and `ipAddress` here come from the in-memory session-metadata map, which is populated at JWT issue time and persists across restarts via a small sidecar in the private bucket. They are **never** included in commit trailers on the public repo — see [behaviors/transactions.md](../behaviors/transactions.md).

## POST /api/auth/sessions/:jti/revoke

Revokes a non-current session by `jti`. Unchanged from Phase 1.

### Response — 204

### Errors

- `404 not_found` — `jti` doesn't match a session we have metadata for (or doesn't belong to caller)
- `409 conflict` with `error.code = "cannot_revoke_current_session"`

## Notes

- **No email/password endpoints.** `/api/auth/register`, `/api/auth/login`, `/api/auth/password-reset/*` do not exist. Trying to call them returns `404 not_found`.
- **GitHub identity is immutable per Person.** Once `Person.githubUserId` is set, it doesn't change. Unlinking GitHub is not a v1 feature; if a user loses access to their GitHub account, they recover through a staff-mediated process. See [behaviors/account-migration.md](../behaviors/account-migration.md).
- **Email is GitHub-sourced.** `PrivateProfile.email` is refreshed on every successful OAuth callback to the user's current primary verified GitHub email. We don't expose a "change email" UI; users change their email on GitHub.
- **The OAuth state cookie expires aggressively** (10 minutes) so abandoned flows don't accumulate.
- **PKCE is required** even though we have a client secret on the server — PKCE protects against authorization-code interception in addition to whatever client-secret protection we already have.
