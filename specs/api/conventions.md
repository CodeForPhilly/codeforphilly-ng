# API: Conventions

Cross-cutting rules for every endpoint under `/api/*`. Per-endpoint specs in this directory only describe what's unique to that endpoint.

## Base URL

All endpoints are mounted under `/api`. There is no API version segment in v1 — breaking changes ship as new endpoints alongside old ones until the old can be retired.

## Content type

- Requests: `application/json` for bodies; `multipart/form-data` only for file uploads (avatar, buzz image).
- Responses: `application/json` always.
- `Accept` headers are honored only insofar as `application/json` is the default; we don't negotiate CSV/RSS in v1 (see [deferred.md](../deferred.md)).

## Response envelope

Every JSON response from the API conforms to one of two shapes:

### Success

```json
{
  "success": true,
  "data": <T>,
  "metadata": { "timestamp": "2026-05-15T18:42:00Z" }
}
```

For paginated lists, the `data` is an array and `metadata` includes pagination:

```json
{
  "success": true,
  "data": [<T>, ...],
  "metadata": {
    "timestamp": "2026-05-15T18:42:00Z",
    "page": 1,
    "perPage": 30,
    "totalItems": 268,
    "totalPages": 9
  }
}
```

### Error

```json
{
  "success": false,
  "error": {
    "code": "validation_failed",
    "message": "Project title is required",
    "fields": { "title": "required" }
  },
  "metadata": { "timestamp": "2026-05-15T18:42:00Z" }
}
```

`error.code` values are stable identifiers clients can switch on:

| Code | HTTP | When |
|---|---:|---|
| `validation_failed` | 422 | Request body or query parameters fail schema validation. `error.fields` carries per-field messages. |
| `unauthenticated` | 401 | No session, or session expired. |
| `forbidden` | 403 | Authenticated but not authorized for this action. |
| `not_found` | 404 | Resource does not exist (or is soft-deleted and the caller can't see deleted items). |
| `conflict` | 409 | Unique constraint violated (e.g., slug taken). |
| `rate_limited` | 429 | Per-IP or per-account rate cap. `Retry-After` header set. |
| `internal_error` | 500 | Unhandled — never includes details in `message`. The full exception is logged with a `traceId` which is returned to the client for support. |

## Authentication

- Session cookie `cfp_session` carries an opaque token. Set by `POST /api/auth/login` and `POST /api/auth/register`; cleared by `POST /api/auth/logout`. See [api/auth.md](auth.md).
- `Secure`, `HttpOnly`, `SameSite=Lax`. In development, `Secure` is dropped when the host is `localhost`.
- The token in the cookie maps to a row in `sessions` (see [data-model.md](../data-model.md)). The cookie value is never the session ID directly; it is the opaque token whose sha256 is stored.
- Endpoints that mutate state require a CSRF mitigation. With `SameSite=Lax` cookies on a same-origin SPA this is sufficient; if we ever expose the API to a different origin, switch to a CSRF token header.

## Authorization

Per-endpoint auth requirements appear in each endpoint table. The vocabulary:

| Marker | Meaning |
|--------|---------|
| `public` | No authentication required. |
| `user` | Any signed-in person. |
| `member` | Signed-in person who is a `project_membership` row for the project. |
| `maintainer` | Signed-in person who is the project's `maintainerId` (or who has `isMaintainer = true` in `project_memberships`). |
| `staff` | `accountLevel` ∈ `{staff, administrator}`. |
| `administrator` | `accountLevel = administrator`. |
| `self` | The acting person matches the resource's owner (e.g., editing your own profile). |

When multiple are listed (`maintainer | staff`), any one suffices. Cross-cutting rules in [behaviors/authorization.md](../behaviors/authorization.md).

## Pagination

List endpoints accept:

| Query param | Type | Default | Notes |
|---|---|---|---|
| `page` | int ≥ 1 | 1 | |
| `perPage` | int 1–100 | 30 | clamp to 100 |

Both are validated; out-of-range values respond `422`.

Responses always include `metadata.page`, `metadata.perPage`, `metadata.totalItems`, `metadata.totalPages`.

## Sorting

List endpoints document allowed sort keys in their own spec. Default sort is documented per endpoint. Sort syntax:

```
?sort=createdAt        # ascending
?sort=-createdAt       # descending
?sort=-stage,title     # multi-key
```

Unknown sort keys → `422 validation_failed`.

## Filtering

Each endpoint declares which filters it accepts. Filters are query parameters with conventional names:

| Convention | Example | Meaning |
|---|---|---|
| `<field>` | `?stage=prototyping` | exact match |
| `<field>In` | `?stageIn=prototyping,testing` | one-of (comma-separated) |
| `tag` | `?tag=tech.flutter` | tag handle in laddr format (namespace `.` slug); the API accepts both this and `?tagId=<uuid>` for forward compat |
| `q` | `?q=balancer` | full-text search across documented fields |

Unknown filter keys → `422 validation_failed` (strict). This catches typos before they silently match nothing.

## Field selection

Not supported in v1. Endpoints return a documented shape; sparse fieldsets and `include=` joins are deferred. If response size becomes a problem, we add it then.

## Timestamps

All timestamps in requests and responses are ISO 8601 UTC strings (`2026-05-15T18:42:00Z`). No epoch seconds, no timezone offsets.

## Slugs vs IDs in URLs

User-facing endpoints accept the entity's `slug` in the path, *not* the UUID:

```
GET  /api/projects/squadquest
POST /api/projects/squadquest/updates
```

The `id` (UUID) is included in responses for client use, but routes use slugs because they're human-readable and stable across the laddr → rewrite migration. See [behaviors/slug-handles.md](../behaviors/slug-handles.md).

The exceptions are sub-resources keyed by sequence (`/projects/squadquest/updates/3`) and authentication endpoints which carry no slug.

## Validation

Every request body and query string is validated by a zod schema declared alongside the route. Validation failures return `422 validation_failed` with per-field details. The shared schemas live in `packages/shared` so the frontend can run the same validation client-side and present errors before submit.

## Rate limiting

Single-replica means rate-limit state is in-memory. Counters reset on restart; acceptable at civic scale.

- Unauthenticated reads: 60 requests / minute / IP
- Authenticated reads: 300 requests / minute / account
- Writes: 30 requests / minute / account
- Auth endpoints (`/api/auth/*`): 10 requests / minute / IP

Exceeded → `429 rate_limited`, `Retry-After` header in seconds.

## Idempotency

Mutating endpoints accept an optional `Idempotency-Key` header (any client-generated string). The API caches the response in-memory keyed by `(personId, idempotencyKey)` for 24 hours; repeat requests with the same key return the same response. In-memory by design — single replica, restart-tolerant: a key that hasn't seen a duplicate within 24h won't see one after a restart either. This matters for cases like "post project update" where a double-tap shouldn't create two updates.

## Logging and trace IDs

Every request has a `traceId` (UUIDv7). It's included in logs and surfaced in error responses' `error.traceId`. If a user reports a problem, the traceId is the link to the server logs.

## OpenAPI

The Fastify schema validators generate an OpenAPI 3.1 document available at `/api/_openapi.json` and a Swagger UI at `/api/_docs`. These are for developers; they're not authoritative — the specs in this directory are.
