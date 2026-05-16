# Behavior: Authorization

## Rule

Every action — viewing data, mutating it, calling an endpoint, rendering a UI control — is governed by an explicit authorization rule. The rule is decided server-side; clients receive `permissions` hints with each response to choose what to render but never **enforce** authorization themselves.

## Applies To

- Every endpoint in [api/](../api/) — each declares an auth marker
- Every screen in [screens/](../screens/) — each declares an Authorization section
- Service-layer code that enforces rules independent of the request layer

## Account levels

Four levels, in increasing power. Each row has the powers of all rows above it.

| Level | Slug | Source |
| ----- | ---- | ------ |
| Anonymous | `anonymous` | No session, or revoked/expired session |
| User | `user` | Default for new accounts |
| Staff | `staff` | Set by an administrator |
| Administrator | `administrator` | Set by another administrator (or manually in seed data — there's always at least one) |

The level is stored on `people.accountLevel`. It's mutable only by administrators, only via `POST /api/people/:slug/account-level` (a deferred endpoint not yet specified). Until that endpoint exists, account-level changes happen via a hand-authored commit to the data repo by an administrator.

## Per-context markers

Authorization rules in endpoint and screen specs use these markers. The vocabulary is intentionally specific so the server can implement each as a guard.

| Marker | Predicate |
| ------ | --------- |
| `public` | Always passes. |
| `user` | Session is valid and not revoked. `accountLevel != anonymous`. |
| `self` | The current user matches the resource owner (their own profile, their own session, their own membership). |
| `member` | Current user has a `ProjectMembership` record for the target project. |
| `maintainer` | Current user is the project's `maintainerId` (or equivalent `isMaintainer = true` on their membership). |
| `poster` / `author` | Current user authored the resource (a buzz item, an update, a help-wanted role). |
| `staff` | `accountLevel ∈ {staff, administrator}`. |
| `administrator` | `accountLevel = administrator`. |

When multiple markers separated by `|` are listed (`maintainer | staff`), any one satisfying suffices.

## Permission hints in responses

Detail endpoints (e.g., `GET /api/projects/:slug`) return a `permissions` object — a flat map of `canX` booleans computed for the current caller. Clients use this to decide which UI to render.

```json
"permissions": {
  "canEdit": true,
  "canManageMembers": false,
  "canPostUpdate": true,
  ...
}
```

The hint is **not authoritative**. Every mutation endpoint re-evaluates the rule. A client that lies to itself ("set canEdit to true") can't bypass anything.

`alreadyExpressedInterest` and similar "state about the caller" fields appear alongside `canX` flags when relevant.

## Session model — stateless JWTs

Sessions are **stateless JWTs**, not database rows. There is no `sessions` sheet. Per-request session lookups don't touch gitsheets.

### Tokens

- **Access JWT** — 15-minute lifetime. Sent on every API request in the `cfp_session` cookie. Payload: `{ sub: personId, jti: uuidv7, accountLevel, exp, iat }`.
- **Refresh JWT** — 30-day lifetime. Sent only on refresh requests in a separate `cfp_refresh` cookie (path-scoped to `/api/auth/refresh`). Payload: `{ sub: personId, jti, exp, iat }`.

Both cookies: `HttpOnly`, `Secure`, `SameSite=Lax`. `Secure` is dropped only when host is `localhost` in development.

Signing: HS256 with `CFP_JWT_SIGNING_KEY` (server-managed secret, rotated on a cadence). Rotation triggers re-issue of all tokens on next refresh.

### Lifecycle

```text
[issuance — flow not yet specified; will be GitHub OAuth callback + account-claim]
        │
        ▼
  Issue access JWT (15m) + refresh JWT (30d) ─▶ Set cookies
        │
        ▼
  Subsequent requests carry access JWT
        │
        ├─ access JWT valid    → handler runs
        ├─ access JWT expired  → 401 with `error.code = "access_token_expired"`
        │                        Frontend hits POST /api/auth/refresh, gets a new pair, retries
        └─ refresh JWT expired → 401 with `error.code = "session_expired"` → user re-authenticates
```

The access-token TTL is intentionally short so revocation has a small blast radius. The refresh-token TTL is "session length" — 30 days of inactivity logs you out.

### Revocation

Explicit sign-out (or staff revoke) writes the JWT's `jti` to the [Revocation](../data-model.md#revocation) sheet with the token's original `expiresAt`. On every authenticated request, the API checks the in-memory `revokedJtis: Set<jti>` set (built from the Revocation sheet at boot, updated synchronously on every revoke).

A periodic in-process task sweeps the Revocation sheet for entries whose `expiresAt < now` and deletes them — revoked tokens that have naturally expired no longer need to be remembered.

This gives us:

- **Survives restart** — Revocation sheet is persisted, in-memory set is rebuilt at boot.
- **Cheap reads** — revocation check is a `Set.has(jti)`.
- **Cheap writes** — only on explicit sign-out, which is rare. No per-request writes anywhere.

### Sign-out everywhere

To sign out *all* devices for a person, write a `Revocation` entry per active `jti` we've issued for them — but since we don't store issued JWTs, we instead write a `Revocation` entry with a sentinel `jti = "*"` plus the `personId`, and the revocation check additionally rejects any JWT whose `iat` is before that sentinel revocation's `createdAt`. Functionally equivalent to "rotate this user's signing scope as of now."

(That sentinel pattern is implementation guidance, not part of the on-disk schema. The Revocation record shape can accommodate it via `jti = "*"` + `personId`.)

### Why not refresh-rotation tracking

A common pattern is to store the latest refresh-token `jti` per person and reject older ones, detecting refresh-token reuse as a compromise signal. v1 skips this. If we observe refresh-token-reuse incidents in practice, we add it then; it's a localized addition to the refresh endpoint's logic, no schema changes needed.

### When an authenticated request fails authorization

- `401 unauthenticated` if no valid session (cookie missing, JWT invalid, JWT revoked, or refresh required) — frontend redirects to `/login?return=<current path>`
- `403 forbidden` if the session is valid but the caller lacks the required marker — frontend shows an inline error or a 403 page; no redirect

## CSRF

- The session cookie is `SameSite=Lax`, so cross-origin POSTs from third parties can't carry it. This is sufficient for a same-origin SPA.
- If/when the API is opened to a different origin or a separate consumer (e.g., a mobile client), switch to:
  - A CSRF token issued at login, returned in a header on each mutating request, validated server-side
- v1 does not implement a header-based CSRF token. The decision is documented so it doesn't become an accidental hole when the deploy topology changes.

## Audit log

The commit log of the data repo **is** the audit log. There is no separate audit sheet or table.

Every mutation — staff action or self-service edit — lands as a structured commit with author, timestamp, full diff, and trailers. See [behaviors/storage.md](storage.md#commits-are-the-audit-log) for the commit-message + trailer convention.

Staff-relevant actions that get audit attention by virtue of being commits:

- Account-level changes (admin grants/revokes staff)
- Project soft-deletes and restores
- Tag merges and deletions
- Help-wanted role transitions when performed by staff (not by the project's own maintainer)
- Member removals when performed by staff

Common audit queries:

| Query | Command |
| ----- | ------- |
| Recent staff actions | `git log --grep='^Actor-Account-Level: \(staff\|administrator\)$'` |
| Everything an actor did | `git log --author='chris@example.com'` |
| All soft-deletes | `git log --grep='^Action: \w\+\.soft-delete$'` |
| History of one record | `git log -- people/janedoe.toml` |

A "Recent staff activity" UI is deferred — staff query via `git log` or the data repo's web interface (GitHub) until then.

## Anti-enumeration

- `GET /api/people/:slug` returns `404 not_found` for soft-deleted people when the caller isn't staff — the same response as a never-existed slug.
- Once the GitHub OAuth + account-claim flow is specified, claim-attempt failures (email match misses, password match misses) should also use a uniform response that doesn't distinguish "no such account" from "wrong proof." That's a constraint on the not-yet-written flow, captured here so it isn't forgotten.

## Account self-deletion

Out of scope for v1. The closest mechanism is requesting deletion from staff. A self-serve account-deletion flow is tracked in [deferred.md](../deferred.md).
