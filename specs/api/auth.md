# API: Authentication

Session management endpoints — `/me`, `/logout`, the session list, and explicit revocation. These are the surface that survives regardless of *how* a session got issued.

The endpoints that actually *issue* sessions (GitHub OAuth start/callback, the account-claim flow) are not yet specified. Email/password sign-in is permanently dropped — see [deferred.md](../deferred.md). Until the OAuth flow lands, sessions exist only via seeded data (the laddr migration imports each Person record but does not auto-issue tokens).

See [behaviors/authorization.md](../behaviors/authorization.md) for the JWT model and revocation semantics, and [api/conventions.md](conventions.md) for the cookie attributes.

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/auth/me` | user | Return the current signed-in person's profile and account level. |
| `POST` | `/api/auth/refresh` | refresh-cookie | Exchange a valid refresh JWT for a fresh access+refresh pair. |
| `POST` | `/api/auth/logout` | user | End the current session (revoke its access + refresh JWT `jti`s). |
| `GET` | `/api/auth/sessions` | user | List the current person's *remembered* sessions — non-revoked refresh-token `jti`s the system is aware of. |
| `POST` | `/api/auth/sessions/:jti/revoke` | user (self) | Revoke a specific session by `jti`. Cannot revoke the current session via this route — use `/logout`. |

## GET /api/auth/me

Returns the current person plus `accountLevel`. Used by the SPA on load to bootstrap the auth context.

### Response — 200

```json
{
  "success": true,
  "data": {
    "person": { /* PersonResponse, see api/people.md */ },
    "accountLevel": "staff"
  }
}
```

If no session, returns 200 with `data.person = null` and `data.accountLevel = "anonymous"`. (We deliberately do not 401 here — the frontend calls this on every page load including public pages.)

## POST /api/auth/refresh

Mints a new access+refresh JWT pair from a valid refresh JWT. Idempotent within the token's window: multiple refreshes against the same refresh JWT return the same new pair until that refresh JWT expires.

### Request

Empty body. The refresh JWT is read from the `cfp_refresh` cookie.

### Response — 200

Empty body. Sets fresh `cfp_session` and `cfp_refresh` cookies.

### Errors

- `401 unauthenticated` with `error.code = "refresh_token_expired"` — refresh JWT is past expiry; user must re-authenticate
- `401 unauthenticated` with `error.code = "refresh_token_revoked"` — refresh JWT's `jti` is in the revocations sheet
- `401 unauthenticated` with `error.code = "no_refresh_token"` — cookie missing

## POST /api/auth/logout

### Request

Empty.

### Response — 204

No body. Clears the `cfp_session` and `cfp_refresh` cookies. Writes the current access JWT's `jti` and refresh JWT's `jti` to the [revocations sheet](../data-model.md#revocation).

## GET /api/auth/sessions

Lists sessions the system has metadata for. A "session" here is a non-revoked refresh JWT we've kept side-channel metadata about (UA, IP) so the user can see it in the account-settings UI. JWTs we haven't tagged with side-channel metadata don't appear in this list — they're still valid as long as the signature checks out and they're not revoked.

(In practice the API records UA + IP + `jti` to an in-memory map on every fresh issue, then opportunistically persists those entries to a `session-metadata` sheet on logout/revoke so the user can see their devices across restarts. This is observability sugar around the stateless JWTs — not a stateful session store.)

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

`current = true` marks the session the request itself authenticated with.

## POST /api/auth/sessions/:jti/revoke

Revokes a non-current session by `jti`. Writes the `jti` to the revocations sheet with the original token's `expiresAt`. Cannot revoke the current session via this route — use `/logout`.

### Response — 204

### Errors

- `404 not_found` — `jti` doesn't match a session we have metadata for (or doesn't belong to caller)
- `409 conflict` with `error.code = "cannot_revoke_current_session"`
