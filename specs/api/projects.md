# API: Projects

CRUD and browse for projects. Sub-resources (members, updates, buzz, help-wanted) have their own files; this file covers the project itself plus the directory browse.

See [data-model.md](../data-model.md#project) for the entity shape, [behaviors/project-stages.md](../behaviors/project-stages.md) for stage rules, and [behaviors/tags.md](../behaviors/tags.md) for tag filtering.

## Endpoints

| Method | Path | Auth | Summary |
|---|---|---|---|
| `GET` | `/api/projects` | public | List/browse projects with filters and sort. |
| `GET` | `/api/projects/:slug` | public | Fetch a single project. |
| `POST` | `/api/projects` | user | Create a new project (caller becomes maintainer). |
| `PATCH` | `/api/projects/:slug` | maintainer \| staff | Update fields. |
| `DELETE` | `/api/projects/:slug` | staff | Soft-delete a project. |
| `POST` | `/api/projects/:slug/restore` | staff | Undo a soft-delete. |
| `POST` | `/api/projects/:slug/change-maintainer` | maintainer \| staff | Reassign the maintainer to another existing member. |

## GET /api/projects

### Query parameters

| Param | Type | Notes |
|---|---|---|
| `q` | string | Free-text search across `title`, `summary`, `readme` (Postgres FTS, tsvector). |
| `stage` | enum | `commenting` \| `bootstrapping` \| `prototyping` \| `testing` \| `maintaining` \| `drifting` \| `hibernating` |
| `stageIn` | csv-of-enum | Multi-value filter. |
| `tag` | string | Tag handle in `<namespace>.<slug>` form (e.g., `tech.flutter`). Repeatable; semantics are AND across repeats. |
| `maintainer` | string | Person slug. |
| `memberSlug` | string | Person slug — returns projects where this person is in `project_memberships`. |
| `helpWanted` | bool | If `true`, only projects with at least one `helpWantedRoles.status = 'open'`. |
| `featured` | bool | If `true`, only projects with `featured = true`. Used by the home page. |
| `sort` | sort spec | Default `-updatedAt`. Allowed keys: `createdAt`, `updatedAt`, `title`, `stage` (stage ordered by `project-stages.md` rank). |
| `page`, `perPage` | int | See [conventions.md](conventions.md#pagination). |

Soft-deleted projects (`deletedAt is not null`) are excluded for non-staff and included for staff. Staff filter: `?includeDeleted=true`.

### Response — 200

```json
{
  "success": true,
  "data": [ProjectListItem, ...],
  "metadata": {
    "page": 1, "perPage": 30, "totalItems": 268, "totalPages": 9,
    "facets": {
      "byTopic":  [{ "tag": "topic.transit",   "title": "Transit",   "count": 28 }, ...],
      "byTech":   [...],
      "byEvent":  [...],
      "byStage":  [{ "stage": "prototyping", "count": 41 }, ...]
    }
  }
}
```

The `facets` object replaces laddr's `projectsTags.{byTopic,byTech,byEvent}` and `projectsStages`. Facets reflect the **unfiltered** corpus so the sidebar counts don't whipsaw when a filter is applied. Top 10 per facet group; full list via [api/tags.md](tags.md).

### ProjectListItem shape

The summary shape used in lists; smaller than the detail response.

```json
{
  "id": "<uuid>",
  "slug": "squadquest",
  "title": "SquadQuest",
  "summary": "Realtime community events without Facebook.",
  "stage": "testing",
  "readmeExcerpt": "SquadQuest is a different kind of civic technology...",  // <= 600 chars, plain text (markdown stripped)
  "maintainer": { "slug": "chris", "fullName": "Chris Alfano", "avatarUrl": "..." } | null,
  "memberCount": 5,
  "members": [PersonAvatar, ...],                                            // first 10 by role then alpha
  "links": {
    "usersUrl": "https://squadquest.app",
    "developersUrl": "https://github.com/SquadQuest/SquadQuest",
    "chatChannel": "squadquest"
  },
  "openHelpWantedCount": 2,
  "tags": [{ "namespace": "tech", "slug": "flutter", "title": "Flutter" }, ...],
  "updatedAt": "2026-04-02T14:11:00Z"
}
```

## GET /api/projects/:slug

Fetches a single project by slug.

### Response — 200

```json
{
  "success": true,
  "data": Project
}
```

### Project shape

```json
{
  "id": "<uuid>",
  "slug": "squadquest",
  "title": "SquadQuest",
  "summary": "...",
  "readme": "## Markdown source ...",
  "readmeHtml": "<h2>Markdown source ...",   // sanitized HTML rendered server-side
  "stage": "testing",
  "stageProgress": 0.5,                       // derived; see project-stages.md
  "maintainer": Person | null,
  "memberships": [ProjectMembership, ...],    // includes all members
  "openHelpWantedRoles": [HelpWantedRole, ...],
  "tags": { "topic": [Tag, ...], "tech": [Tag, ...], "event": [Tag, ...] },
  "links": { "usersUrl": "...", "developersUrl": "...", "chatChannel": "..." },
  "counts": { "updates": 12, "buzz": 3, "members": 5 },
  "permissions": {
    "canEdit": true,
    "canManageMembers": false,
    "canPostUpdate": true,
    "canLogBuzz": true,
    "canPostHelpWanted": true,
    "canDelete": false
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```

`permissions` is the *current caller's* permissions on this project — the frontend uses it to decide which actions to render. The server still enforces the same rules on each mutation endpoint.

### Errors

- `404 not_found` — slug doesn't match (or is soft-deleted and caller can't see deleted).

## POST /api/projects

Create a new project. Caller becomes the maintainer and is added as a `Founder` membership.

### Request

```json
{
  "title": "My New Project",
  "slug": "my-new-project",     // optional; derived from title if omitted
  "summary": "Tagline (optional)",
  "readme": "Markdown source",
  "usersUrl": "https://...",
  "developersUrl": "https://...",
  "chatChannel": "my-channel",
  "stage": "commenting",         // optional; default 'commenting'
  "tags": {                      // optional
    "topic": ["transit", "mapping"],
    "tech":  ["typescript"],
    "event": []
  }
}
```

Tags reference existing tag slugs by namespace + slug. Unknown tag slugs auto-create new tags only when the caller has `accountLevel ∈ {staff, administrator}`; otherwise unknown tags return `422` with a hint to ask staff to add them.

### Response — 201

```json
{ "success": true, "data": Project }
```

### Errors

- `422 validation_failed`
- `409 conflict` — slug already taken

## PATCH /api/projects/:slug

Update one or more fields. Field-level. Omitted fields are unchanged. Tags, if present, fully replace the existing set within each namespace included in the request.

### Allowed fields by role

| Field | maintainer | staff |
|---|:---:|:---:|
| title, summary, readme, usersUrl, developersUrl, chatChannel | ✓ | ✓ |
| stage | ✓ | ✓ |
| tags.{topic,tech,event} | ✓ | ✓ |
| slug | – | ✓ |
| featured, featuredImageKey | – | ✓ |
| maintainerId | – | – (use change-maintainer) |

### Response — 200

```json
{ "success": true, "data": Project }
```

### Errors

- `403 forbidden` — caller is not maintainer or staff
- `422 validation_failed`
- `409 conflict` — slug change collides

## DELETE /api/projects/:slug

Soft-delete. Sets `deletedAt = now()`. Removes the project from public lists, leaves its row and sub-resources intact for restore.

### Response — 204

### Errors

- `403 forbidden`
- `404 not_found`

## POST /api/projects/:slug/restore

Unset `deletedAt`.

### Response — 200

```json
{ "success": true, "data": Project }
```

## POST /api/projects/:slug/change-maintainer

### Request

```json
{ "personSlug": "another-member" }
```

The new maintainer must already be a member (`project_memberships` row exists). If not, respond `409 conflict` with `error.code = "not_a_member"`.

The previous maintainer remains a member with their old role (or `"Maintainer (former)"` if their role was previously `null`).

### Response — 200

```json
{ "success": true, "data": Project }
```

## Notes

- **Slug changes** create a 301 redirect from the old slug for 90 days (handled at the web layer, not the API). The API itself accepts the new slug only after the change. See [behaviors/slug-handles.md](../behaviors/slug-handles.md).
- **README rendering** happens server-side via the markdown pipeline in [behaviors/markdown-rendering.md](../behaviors/markdown-rendering.md). The `readmeHtml` field is always derived from `readme` on read.
- **Stage transitions** are free-form in v1 — any role permitted to edit can set any stage. We don't enforce ordering. See [behaviors/project-stages.md](../behaviors/project-stages.md) for the rationale and what we want eventually.
