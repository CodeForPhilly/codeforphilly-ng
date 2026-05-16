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

The level is stored on `people.accountLevel`. It's mutable only by administrators, only via `POST /api/people/:slug/account-level` (a deferred endpoint not in v1's auth.md). Until that endpoint exists, account-level changes happen via direct database edit.

## Per-context markers

Authorization rules in endpoint and screen specs use these markers. The vocabulary is intentionally specific so the server can implement each as a guard.

| Marker | Predicate |
| ------ | --------- |
| `public` | Always passes. |
| `user` | Session is valid and not revoked. `accountLevel != anonymous`. |
| `self` | The current user matches the resource owner (their own profile, their own session, their own membership). |
| `member` | Current user has a `project_memberships` row for the target project. |
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

## Session lifecycle

- Sessions live in the `sessions` table; the cookie carries the opaque token whose sha256 is the lookup key.
- `expiresAt` is sliding — extended on use when the remaining lifetime falls below 7 days.
- `revokedAt` non-null → treated as invalid.
- The session can also be invalidated by deleting/soft-deleting the owning person.

When an authenticated request fails authorization, the response is:

- `401 unauthenticated` if no valid session (cookie missing or invalid) — frontend redirects to `/login?return=<current path>`
- `403 forbidden` if the session is valid but the caller lacks the required marker — frontend shows an inline error or a 403 page; no redirect

## CSRF

- The session cookie is `SameSite=Lax`, so cross-origin POSTs from third parties can't carry it. This is sufficient for a same-origin SPA.
- If/when the API is opened to a different origin or a separate consumer (e.g., a mobile client), switch to:
  - A CSRF token issued at login, returned in a header on each mutating request, validated server-side
- v1 does not implement a header-based CSRF token. The decision is documented so it doesn't become an accidental hole when the deploy topology changes.

## Audit log

A `staff_actions` table records:

- Account-level changes (admin grants/revokes staff)
- Project soft-deletes and restores
- Tag merges and deletions
- Help-wanted role transitions when performed by staff (not by the project's own maintainer)
- Member removals when performed by staff

Row shape:

```sql
staff_actions(
  id uuid,
  actorId uuid,
  action text,
  subjectType text,        -- 'project' | 'person' | 'tag' | 'help_wanted_role' | etc.
  subjectId uuid,
  before jsonb null,
  after  jsonb null,
  reason text null,
  createdAt timestamptz
)
```

This is a write-only log. There's no UI for it in v1 — staff just have the rows available via direct DB query. A "Recent staff activity" screen is deferred.

## Anti-enumeration

- Login failures are uniformly `401 unauthenticated` with `error.code = "invalid_credentials"`, never distinguishing email-not-found from password-wrong.
- Password reset requests are uniformly `202` regardless of whether the email is registered.
- `GET /api/people/:slug` returns `404 not_found` for soft-deleted people when the caller isn't staff — the same response as a never-existed slug.

## Account self-deletion

Out of scope for v1. The closest mechanism is requesting deletion from staff. A self-serve account-deletion flow is tracked in [deferred.md](../deferred.md).
