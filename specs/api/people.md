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
| `PATCH` | `/api/people/:slug/newsletter` | self \| staff | Update newsletter opt-in state (private-store mutation; no public commit). |
| `POST` | `/api/people/:slug/deactivate` | self \| staff | Soft-deactivate (sets `deletedAt`). |
| `POST` | `/api/people/:slug/reactivate` | self \| staff | Reactivate (clears `deletedAt`). |
| `POST` | `/api/people/:slug/purge` | administrator | Cascading hard-delete of person + their content. |
| `POST` | `/api/people/:slug/account-level` | administrator | Change `accountLevel` (audit-logged). |

## GET /api/people

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `q` | string | Full-text on `fullName`, `bio`. |
| `tag` | string | Repeatable. Tag handle (e.g., `tech.python`). AND across repeats. |
| `accountLevel` | enum | `user` \| `staff` \| `administrator`. Staff-only filter — for a non-staff caller it returns an empty list (a 200 with no items), not a `403`, so the filter's existence isn't a signal. |
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
  "slackHandle": "janedoe",                 // null if unset
  "accountLevel": "staff",                  // visible to self and staff only; "user" otherwise
  "deletedAt": null,                        // ISO timestamp if deactivated; null otherwise. Visible to self + staff only (always null to others)
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
- `deletedAt` — the real timestamp is shown to self + staff; everyone else always sees `null`

### Errors

- `404 not_found` — slug doesn't exist, or person is soft-deleted and caller is not staff

## PATCH /api/people/:slug

Self or staff. Self cannot change their own `accountLevel`; only administrators can change account levels (and only via the dedicated [`POST /api/people/:slug/account-level`](#post-apipeopleslugaccount-level) endpoint — `accountLevel` passed in a generic PATCH body is rejected by the schema, not silently applied).

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

Changing `email` does not log out other sessions in v1. The sign-out-everywhere mechanism (revoke all of a person's JWTs by `jti`) is documented in [behaviors/authorization.md](../behaviors/authorization.md) but not auto-triggered on email change.

## POST /api/people/:slug/avatar

Multipart upload, single file field `image`.

| Constraint | Value |
| ---------- | ----- |
| Max size | 5 MB |
| Allowed types | `image/png`, `image/jpeg`, `image/webp` |

Server crops to a square and stores the original plus the 128x128 thumbnail as gitsheets attachments alongside the person's record (`people/<slug>/avatar.jpg`, `people/<slug>/avatar-128.jpg`). `avatarKey` is set to the relative path. Served via `GET /api/attachments/<key>`. See [behaviors/storage.md](../behaviors/storage.md#attachments).

### Response — 200

```json
{ "success": true, "data": { "avatarUrl": "https://..." } }
```

## POST /api/people/:slug/deactivate

Self or staff. Sets `deletedAt = now()`. Profile becomes 404 to non-staff. References to this person in other records render a placeholder. The person can still sign in and reactivate.

### Response — 200

```json
{ "success": true, "data": Person }
```

### Errors

- `403 forbidden` — caller is not the person themselves, staff, or admin
- `404 not_found` — slug doesn't exist

## POST /api/people/:slug/reactivate

Self or staff. Clears `deletedAt`. Person becomes visible again.

### Response — 200

```json
{ "success": true, "data": Person }
```

### Errors

- `403 forbidden` — caller is not the person themselves, staff, or admin
- `404 not_found` — slug doesn't exist (even for non-staff, to allow self-reactivation)

## POST /api/people/:slug/purge

Administrator-only. Atomically hard-deletes the person record and cascades: project-memberships, help-wanted-interest, person tag-assignments, project-updates (authored), project-buzz (posted), and blog-posts (authored). All in one gitsheets commit. Git-revertable.

Unlike the offline spam-prune (which nulls `authorId` on updates), purge DELETES the authored content — it is the on-demand garbage-collection path for spam accounts.

### Response — 204

### Errors

- `403 forbidden` — caller is not an administrator
- `404 not_found` — slug doesn't exist

## Deactivated person placeholder

When a deactivated person is referenced in a serialized response (e.g. project member, update author, blog author, help-wanted postedBy), the reference must be substituted with a placeholder rather than omitted, so counts and history stay coherent:

```json
{ "slug": null, "fullName": "Deactivated user", "avatarUrl": null, "deactivated": true }
```

This placeholder shape applies to the `PersonAvatar` reference type used in: project memberships, project-update `author`, project-buzz `postedBy`, help-wanted `postedBy`/`filledBy`, and blog-post `author`.

## POST /api/people/:slug/account-level

Administrator-only. Changes a person's `accountLevel`. This is the *only* way to change `accountLevel` — it is deliberately a dedicated endpoint, not a field on the generic `PATCH /api/people/:slug`, so the privilege change is explicit and audit-logged.

### Request body

```json
{ "level": "staff" }
```

`level` is one of `user` | `staff` | `administrator`. Setting the person's current level is an idempotent no-op (still 200).

### Response — 200

Returns the updated person (same shape as `GET /api/people/:slug`), so the caller sees the new `accountLevel`.

### Audit trail

The gitsheets commit carries `Action: account-level.change` plus `Previous-Account-Level` and `New-Account-Level` trailers (in addition to the standard actor/subject trailers), so privilege changes are traceable in the data-repo history.

### Last-administrator guard

Demoting the **last** administrator (the only person with `accountLevel: administrator`) is rejected with `422` — otherwise the change would lock everyone out of admin operations. This covers an admin demoting themselves when they are the sole administrator.

### Errors

- `403 forbidden` — caller is not an administrator
- `404 not_found` — slug doesn't exist
- `422 validation_failed` — `level` missing / not one of the three enum values (schema validation), or the change would demote the last administrator

## Deferred admin sub-endpoints

- `POST /api/people/:slug/impersonate` — admin-only. Starts a temporary impersonation session. Not in v1; flagged here so admin tooling has a place to grow into.
