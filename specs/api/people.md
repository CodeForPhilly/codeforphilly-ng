# API: People

Browse and view members. The current-user mutations live on `/api/auth/me` (in [api/auth.md](auth.md)) and the profile-update endpoints below.

See [data-model.md](../data-model.md#person).

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/people` | public | Browse members. |
| `GET` | `/api/people/:slug` | public | Fetch a single person's profile. |
| `PATCH` | `/api/people/:slug` | self \| staff | Update profile. |
| `POST` | `/api/people/:slug/avatar` | self \| staff | Upload an avatar image (multipart). |
| `DELETE` | `/api/people/:slug` | administrator | Soft-delete (close account). |

## GET /api/people

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `q` | string | Full-text on `fullName`, `bio`. |
| `tag` | string | Repeatable. Tag handle (e.g., `tech.python`). AND across repeats. |
| `accountLevel` | enum | `user` \| `staff` \| `administrator`. Staff-only filter. |
| `sort` | sort | Default `-createdAt`. Allowed: `createdAt`, `fullName`. |
| `page`, `perPage` | int | Default `perPage = 30`. |

### Response — 200

```json
{
  "success": true,
  "data": [PersonListItem, ...],
  "metadata": {
    "page": 1, "perPage": 30, "totalItems": 1240,
    "facets": {
      "byTopic": [{ "tag": "topic.transit", "count": 41 }, ...],
      "byTech":  [...]
    }
  }
}
```

### PersonListItem shape

```json
{
  "slug": "chris",
  "fullName": "Chris Alfano",
  "avatarUrl": "https://...",
  "bioExcerpt": "First ~200 chars of bio, markdown stripped.",
  "memberOfCount": 7,                       // active project memberships
  "tags": [{ "namespace": "tech", "slug": "typescript", "title": "TypeScript" }, ...],
  "createdAt": "..."
}
```

## GET /api/people/:slug

### Response — 200

```json
{ "success": true, "data": Person }
```

### Person shape

```json
{
  "id": "<uuid>",
  "slug": "chris",
  "fullName": "Chris Alfano",
  "firstName": "Chris",
  "lastName": "Alfano",
  "avatarUrl": "https://...",
  "bio": "Markdown source...",
  "bioHtml": "<p>...</p>",
  "accountLevel": "staff",                  // visible to self and staff only; "user" otherwise
  "tags": { "topic": [Tag, ...], "tech": [Tag, ...] },
  "memberships": [
    {
      "project": { "slug": "squadquest", "title": "SquadQuest", "stage": "testing" },
      "role": "Founder",
      "isMaintainer": true,
      "joinedAt": "..."
    }, ...
  ],
  "recentUpdates": [ProjectUpdateSummary, ...],   // last 5 updates this person authored
  "permissions": { "canEdit": true, "canChangeAccountLevel": false },
  "createdAt": "...",
  "updatedAt": "..."
}
```

Fields visible only to self or staff:

- `email` (not in the shape above; added only when authorized)
- `firstName`, `lastName` (visible to all but editable only by self/staff)
- `accountLevel` value beyond a generic "user" — public callers always see `"user"` regardless of true level

### Errors

- `404 not_found` — slug doesn't exist, or person is soft-deleted and caller is not staff

## PATCH /api/people/:slug

Self or staff. Self cannot change their own `accountLevel`; only administrators can change account levels (and only via a staff-only sub-endpoint, not by passing `accountLevel` in a generic PATCH).

### Request

```json
{
  "fullName": "...",
  "firstName": "...",
  "lastName": "...",
  "bio": "Markdown source",
  "slug": "newslug",
  "email": "new@example.com",
  "slackHandle": "janedoe",
  "tags": {
    "topic": ["transit"],
    "tech":  ["typescript", "fastify"]
  }
}
```

Editable by self:

- `fullName`, `firstName`, `lastName`, `bio`, `tags`, `email`, `slug`, `slackHandle`

Editable by staff additionally:

- (none — staff-only fields like `accountLevel` get their own endpoint)

### Response — 200

```json
{ "success": true, "data": Person }
```

### Errors

- `409 conflict` — slug or email taken
- `422 validation_failed`

### Email change side-effects

Changing `email` does not log out other sessions in v1, but invalidates any in-flight password-reset tokens.

## POST /api/people/:slug/avatar

Multipart upload, single file field `image`.

| Constraint | Value |
| ---------- | ----- |
| Max size | 5 MB |
| Allowed types | `image/png`, `image/jpeg`, `image/webp` |

Server crops to a square and stores the original plus the 128x128 thumbnail in S3. `avatarKey` is set to the object key.

### Response — 200

```json
{ "success": true, "data": { "avatarUrl": "https://..." } }
```

## DELETE /api/people/:slug

Administrator-only. Sets `deletedAt = now()`. Profile becomes 404 to non-staff; their authored updates and buzz remain with `author = null`.

### Response — 204

## Staff-only sub-endpoints (deferred to staff specs)

- `POST /api/people/:slug/account-level` — change `accountLevel` (admin-only). Body: `{ "level": "staff" }`. Audit-logged.
- `POST /api/people/:slug/impersonate` — admin-only. Starts a temporary impersonation session. Not in v1; flagged here so admin tooling has a place to grow into.
