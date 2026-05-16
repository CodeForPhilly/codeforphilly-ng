# API: Authentication

Session-based auth with opaque tokens in an HttpOnly cookie. Email + password for v1. See [conventions.md](conventions.md) for the cookie attributes and [behaviors/authorization.md](../behaviors/authorization.md) for the authorization model.

## Endpoints

| Method | Path | Auth | Summary |
|---|---|---|---|
| `POST` | `/api/auth/register` | public | Create a new account and start a session. |
| `POST` | `/api/auth/login` | public | Start a session from email + password. |
| `POST` | `/api/auth/logout` | user | End the current session. |
| `POST` | `/api/auth/password-reset/request` | public | Send a password-reset email. |
| `POST` | `/api/auth/password-reset/confirm` | public | Set a new password from a reset token. |
| `GET` | `/api/auth/me` | user | Return the current signed-in person's profile and account level. |
| `GET` | `/api/auth/sessions` | user | List the current person's active sessions. |
| `POST` | `/api/auth/sessions/:id/revoke` | user (self) | Revoke a specific session. Cannot revoke the current session via this route — use `/logout`. |

## POST /api/auth/register

### Request

```json
{
  "email": "person@example.com",
  "password": "...",
  "fullName": "Jane Doe",
  "slug": "janedoe"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| email | string | yes | RFC 5322. Unique (case-insensitive). |
| password | string | yes | 12–256 chars. No other complexity rule (NIST guidance). Checked against the [Pwned Passwords range API](https://haveibeenpwned.com/API/v3#PwnedPasswords); rejected if seen ≥10 times. |
| fullName | string | yes | 1–120 chars. |
| slug | string | no | If omitted, derived from `fullName`. Must match `^[a-z0-9][a-z0-9-]{1,49}$`. Unique. |

### Response — 201

```json
{
  "success": true,
  "data": {
    "person": { /* PersonResponse */ },
    "accountLevel": "user"
  }
}
```

Sets the `cfp_session` cookie. The new person is created at `accountLevel = user` with `emailVerifiedAt = null` (verification is sent but not required to use the site for v1).

### Errors

- `422 validation_failed` — bad input
- `409 conflict` — `email` or `slug` already exists. `error.fields` identifies which.

## POST /api/auth/login

### Request

```json
{
  "email": "person@example.com",
  "password": "..."
}
```

### Response — 200

Same shape as register. Sets the `cfp_session` cookie.

### Errors

- `401 unauthenticated` with `error.code = "invalid_credentials"` — email not found OR password wrong. The two cases are not distinguished in the response (no user enumeration).
- `403 forbidden` with `error.code = "account_disabled"` — `people.deletedAt is not null`.

## POST /api/auth/logout

### Request

Empty.

### Response — 204

No body. Clears the `cfp_session` cookie. Marks the underlying `sessions` row `revokedAt = now()`.

## POST /api/auth/password-reset/request

### Request

```json
{ "email": "person@example.com" }
```

### Response — 202

Empty `data`. Always 202 even if email isn't registered (no user enumeration).

A token is mailed to the address if it exists. Tokens are single-use, expire in 1 hour, are stored hashed.

## POST /api/auth/password-reset/confirm

### Request

```json
{
  "token": "...",
  "password": "..."
}
```

### Response — 200

Sets the `cfp_session` cookie and starts a new session for the person.

### Errors

- `422 validation_failed` — token missing or password rejected (too short / Pwned)
- `401 unauthenticated` with `error.code = "invalid_token"` — expired, already used, or never existed

## GET /api/auth/me

Returns the current person (full PersonResponse shape — see [api/people.md](people.md)) plus `accountLevel`. Used by the SPA on load to bootstrap the auth context.

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

## GET /api/auth/sessions

### Response — 200

```json
{
  "success": true,
  "data": [
    {
      "id": "<uuid>",
      "userAgent": "Mozilla/5.0 ...",
      "ipAddress": "1.2.3.4",
      "createdAt": "...",
      "expiresAt": "...",
      "current": true
    }
  ]
}
```

`current = true` marks the session the request itself authenticated with.

## POST /api/auth/sessions/:id/revoke

Revokes a non-current session. Cannot revoke `:id` of the current session (use `/logout`).

### Response — 204

### Errors

- `404 not_found` — session doesn't exist or doesn't belong to caller
- `409 conflict` with `error.code = "cannot_revoke_current_session"`

## Notes

- **Token format:** 32 bytes of CSPRNG, base64url-encoded. Stored as sha256 in `sessions.tokenHash`.
- **Session lifetime:** 30 days sliding. Each authenticated request bumps `expiresAt` if the remaining lifetime is < 7 days (to avoid hammering the DB on every request).
- **Sign-out everywhere:** Not a v1 endpoint, but trivial — iterate `sessions` for the person and set `revokedAt`. Add when needed.
- **Email verification:** Tokens for `emailVerifiedAt` work the same as password-reset tokens but expire in 7 days. Endpoint not specified in v1; verification is sent on register but not enforced.
- **MFA:** Deferred.
