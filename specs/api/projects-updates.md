# API: Project Updates

Markdown-formatted posts on a project. Was laddr's `ProjectUpdate`. See [data-model.md](../data-model.md#projectupdate).

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/projects/:slug/updates` | public | List a project's updates, newest first. |
| `GET` | `/api/projects/:slug/updates/:number` | public | Fetch a single update by per-project sequence number. |
| `POST` | `/api/projects/:slug/updates` | member \| staff | Post a new update. |
| `PATCH` | `/api/projects/:slug/updates/:number` | author \| staff | Edit an update. |
| `DELETE` | `/api/projects/:slug/updates/:number` | author \| staff | Delete an update. |
| `GET` | `/api/project-updates` | public | Global feed of recent updates across all projects. |

## GET /api/projects/:slug/updates

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `page`, `perPage` | int | Default `perPage = 20`. |
| `sort` | sort | Default `-createdAt`. Allowed: `createdAt`, `number`. |

### Response — 200

```json
{
  "success": true,
  "data": [ProjectUpdate, ...],
  "metadata": { ... }
}
```

## GET /api/projects/:slug/updates/:number

Fetch by the per-project sequence number, e.g., `/api/projects/squadquest/updates/3`.

### Response — 200

```json
{ "success": true, "data": ProjectUpdate }
```

## POST /api/projects/:slug/updates

Caller must be a project member or staff. Author is the caller.

### Request

```json
{ "body": "Markdown source." }
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| body | yes | Markdown. 1–20,000 chars. |

### Response — 201

```json
{ "success": true, "data": ProjectUpdate }
```

The new update's `number` is assigned as `max(existing.number) + 1` within the project. Deleting an update does **not** renumber siblings — numbers are stable URLs.

## PATCH /api/projects/:slug/updates/:number

Only the original author can edit (or staff). No edit-window restriction.

### Request

```json
{ "body": "Revised markdown." }
```

### Response — 200

```json
{ "success": true, "data": ProjectUpdate }
```

## DELETE /api/projects/:slug/updates/:number

Hard delete. The number is **not** reused. Updates are not versioned in v1 (see [deferred.md](../deferred.md)).

### Response — 204

## GET /api/project-updates

Global feed of recent updates across all (non-deleted) projects. Used by the home page activity stream and the standalone `/project-updates` browse.

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `page`, `perPage` | int | Default `perPage = 30`. |
| `since` | iso8601 | If present, only return updates with `createdAt >= since`. |
| `tag` | string | Filter to projects matching the tag. |

### Response — 200

```json
{
  "success": true,
  "data": [ProjectUpdate, ...]   // each item embeds projectSummary
}
```

## ProjectUpdate shape

```json
{
  "id": "<uuid>",
  "number": 3,
  "project": {
    "slug": "squadquest",
    "title": "SquadQuest"
  },
  "author": PersonAvatar | null,    // null if the author was deleted
  "body": "Markdown source",
  "bodyHtml": "<p>...</p>",          // sanitized HTML
  "permissions": {
    "canEdit": false,
    "canDelete": true
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```
