# API: Project Buzz

External press, articles, social posts about a project. Was laddr's `ProjectBuzz`. See [data-model.md](../data-model.md#projectbuzz).

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/projects/:slug/buzz` | public | List a project's buzz, newest first. |
| `POST` | `/api/projects/:slug/buzz` | user | Log a new buzz item. |
| `PATCH` | `/api/projects/:slug/buzz/:buzzSlug` | poster \| staff | Edit a buzz item. |
| `DELETE` | `/api/projects/:slug/buzz/:buzzSlug` | poster \| staff | Remove a buzz item. |
| `GET` | `/api/project-buzz` | public | Global buzz feed. |

Buzz is keyed in URLs by its own `slug` (derived from `headline`) so URLs like `/projects/foo/buzz/inquirer-praises-foo` stay stable across edits.

## GET /api/projects/:slug/buzz

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `page`, `perPage` | int | Default `perPage = 20`. |
| `sort` | sort | Default `-publishedAt`. Allowed: `publishedAt`, `createdAt`. |

### Response — 200

```json
{
  "success": true,
  "data": [ProjectBuzz, ...]
}
```

## POST /api/projects/:slug/buzz

Any signed-in user can log buzz on any project (laddr precedent). The poster is recorded.

### Request

```json
{
  "headline": "The Inquirer praises Project X",
  "url": "https://www.inquirer.com/...",
  "publishedAt": "2026-04-12",
  "summary": "Optional excerpt or quote.",
  "imageUpload": { "key": "buzz-uploads/abc-123.jpg" }    // optional; from prior upload endpoint
}
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| headline | yes | 1–200 chars. |
| url | yes | HTTPS. Unique within `(projectId, url)`. |
| publishedAt | yes | Date or datetime. Date-only normalized to T00:00:00Z. |
| summary | no | ≤ 2,000 chars markdown. |
| imageUpload.key | no | Object storage key from a prior `POST /api/uploads` (separate spec, not in v1 for general media; for buzz, allow direct upload URL flow). |

### Response — 201

```json
{ "success": true, "data": ProjectBuzz }
```

### Errors

- `409 conflict` with `error.code = "duplicate_url"` — URL already logged for this project

## PATCH /api/projects/:slug/buzz/:buzzSlug

Editable fields: `headline`, `url`, `publishedAt`, `summary`, `imageUpload`. Slug regenerates only when explicitly requested via `?regenerateSlug=true` to avoid silently breaking shared URLs.

### Response — 200

```json
{ "success": true, "data": ProjectBuzz }
```

## DELETE /api/projects/:slug/buzz/:buzzSlug

Hard delete. The image (if any) is removed from object storage by a background job.

### Response — 204

## GET /api/project-buzz

Global feed of buzz across all projects.

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `page`, `perPage` | int | Default `perPage = 30`. |
| `since` | iso8601 | |
| `tag` | string | Filter to projects matching the tag. |

### Response — 200

```json
{
  "success": true,
  "data": [ProjectBuzz, ...]
}
```

## ProjectBuzz shape

```json
{
  "id": "<uuid>",
  "slug": "inquirer-praises-foo",
  "project": { "slug": "squadquest", "title": "SquadQuest" },
  "postedBy": PersonAvatar | null,
  "headline": "The Inquirer praises Foo",
  "url": "https://...",
  "publishedAt": "2026-04-12T00:00:00Z",
  "summary": "Excerpt.",
  "summaryHtml": "<p>Excerpt.</p>",
  "imageUrl": "https://cdn.../buzz-uploads/abc-123.jpg" | null,
  "permissions": {
    "canEdit": false,
    "canDelete": false
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```
