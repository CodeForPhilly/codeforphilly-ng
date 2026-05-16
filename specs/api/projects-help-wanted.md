# API: Project Help-Wanted Roles

Specific volunteer asks posted by project maintainers — the new feature in v1. See [data-model.md](../data-model.md#helpwantedrole) and [behaviors/help-wanted-roles.md](../behaviors/help-wanted-roles.md).

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/projects/:slug/help-wanted` | public | List a project's help-wanted roles (open and closed). |
| `POST` | `/api/projects/:slug/help-wanted` | maintainer \| staff | Post a new role. |
| `PATCH` | `/api/projects/:slug/help-wanted/:roleId` | poster \| maintainer \| staff | Edit a role. |
| `POST` | `/api/projects/:slug/help-wanted/:roleId/express-interest` | user | Express interest in a role (notifies the maintainer). |
| `POST` | `/api/projects/:slug/help-wanted/:roleId/fill` | maintainer \| staff | Mark as filled, optionally by a specific person. |
| `POST` | `/api/projects/:slug/help-wanted/:roleId/close` | maintainer \| staff | Close without filling (cancelled, expired). |
| `POST` | `/api/projects/:slug/help-wanted/:roleId/reopen` | maintainer \| staff | Reopen a previously filled/closed role. |
| `GET` | `/api/help-wanted` | public | Cross-project browse of open roles. |

## GET /api/projects/:slug/help-wanted

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `status` | enum | `open` \| `filled` \| `closed`. Default returns all. |
| `page`, `perPage` | int | Default `perPage = 20`. |
| `sort` | sort | Default `-createdAt`. Allowed: `createdAt`, `commitmentHoursPerWeek`. |

### Response — 200

```json
{ "success": true, "data": [HelpWantedRole, ...] }
```

## POST /api/projects/:slug/help-wanted

### Request

```json
{
  "title": "React developer for admin dashboard",
  "description": "Markdown details on what we need.",
  "commitmentHoursPerWeek": 4,
  "tags": {
    "tech": ["react", "typescript"]
  }
}
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| title | yes | 1–120 chars. |
| description | yes | Markdown. 1–4,000 chars. |
| commitmentHoursPerWeek | no | Int ≥ 0. 0 means flexible/unspecified. |
| tags | no | Same shape as projects. Tags are scoped via `taggableType = 'help_wanted_role'`. |

### Response — 201

```json
{ "success": true, "data": HelpWantedRole }
```

## PATCH /api/projects/:slug/help-wanted/:roleId

Editable fields: `title`, `description`, `commitmentHoursPerWeek`, `tags`. Status changes go through the dedicated transition endpoints.

### Response — 200

```json
{ "success": true, "data": HelpWantedRole }
```

## POST /api/projects/:slug/help-wanted/:roleId/express-interest

Records that the current user is interested. The maintainer is notified via email and (if configured) a Slack DM. Self-service interest does not change the role's status.

### Request

```json
{ "message": "Hi! I'd love to help. I've shipped 3 React dashboards before." }
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| message | no | ≤ 2,000 chars plain text. Included in the notification verbatim. |

### Response — 202

```json
{ "success": true, "data": { "delivered": true } }
```

### Errors

- `409 conflict` with `error.code = "already_expressed"` — caller has already expressed interest in this role within the last 30 days
- `409 conflict` with `error.code = "role_not_open"` — role is filled or closed

## POST /api/projects/:slug/help-wanted/:roleId/fill

### Request

```json
{ "filledBySlug": "newperson" }
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| filledBySlug | no | Person slug. If omitted, role is marked filled without attribution. |

Sets `status = 'filled'`, `filledAt = now()`, and (if provided) `filledById`. Also adds `filledBy` as a project member with role `"Help-wanted: <title>"` if they aren't already a member — see [behaviors/help-wanted-roles.md](../behaviors/help-wanted-roles.md).

### Response — 200

```json
{ "success": true, "data": HelpWantedRole }
```

## POST /api/projects/:slug/help-wanted/:roleId/close

Sets `status = 'closed'`, `closedAt = now()`. Does not modify project membership.

### Response — 200

```json
{ "success": true, "data": HelpWantedRole }
```

## POST /api/projects/:slug/help-wanted/:roleId/reopen

Reverts to `status = 'open'`, clears `filledAt`/`filledById`/`closedAt`. Membership added by a previous `fill` is **not** auto-removed.

### Response — 200

```json
{ "success": true, "data": HelpWantedRole }
```

## GET /api/help-wanted

Cross-project browse of open roles. Used by the `/help-wanted` screen.

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `status` | enum | Default `open`. |
| `tag` | string | Multi-value via repeat. Filters on the role's tags. |
| `commitmentMax` | int | Only show roles whose `commitmentHoursPerWeek <= commitmentMax`. |
| `q` | string | Full-text on `title` + `description`. |
| `sort` | sort | Default `-createdAt`. |
| `page`, `perPage` | int | Default `perPage = 30`. |

### Response — 200

```json
{
  "success": true,
  "data": [HelpWantedRole, ...],
  "metadata": {
    "facets": {
      "byTech": [{ "tag": "tech.react", "count": 7 }, ...],
      "byTopic": [...]
    }
  }
}
```

## HelpWantedRole shape

```json
{
  "id": "<uuid>",
  "project": { "slug": "squadquest", "title": "SquadQuest" },
  "postedBy": PersonAvatar | null,
  "title": "React developer for admin dashboard",
  "description": "Markdown details...",
  "descriptionHtml": "<p>...</p>",
  "commitmentHoursPerWeek": 4,
  "status": "open",
  "filledBy": PersonAvatar | null,
  "filledAt": null,
  "closedAt": null,
  "tags": { "topic": [...], "tech": [...] },
  "interestCount": 3,
  "permissions": {
    "canEdit": false,
    "canExpressInterest": true,
    "alreadyExpressedInterest": false,
    "canFill": false,
    "canClose": false
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```
