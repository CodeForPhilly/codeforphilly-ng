# API: Tags

Browse the tag taxonomy. Tag *assignment* happens via the parent resource (e.g., `PATCH /api/projects/:slug` with a `tags` field). This file covers reading the tag space and (for staff) curating it.

See [data-model.md](../data-model.md#tag) and [behaviors/tags.md](../behaviors/tags.md).

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/tags` | public | List tags. |
| `GET` | `/api/tags/:handle` | public | Fetch a single tag by handle (`namespace.slug`). |
| `POST` | `/api/tags` | staff | Create a new tag. |
| `PATCH` | `/api/tags/:handle` | staff | Update title or merge into another tag. |
| `DELETE` | `/api/tags/:handle` | staff | Delete a tag (cascades through TagAssignment). |
| `GET` | `/api/tags/:handle/projects` | public | List projects tagged with this tag (delegates to projects browse with the filter pre-applied). |
| `GET` | `/api/tags/:handle/people` | public | Same, for people. |

## GET /api/tags

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `namespace` | enum | `topic` \| `tech` \| `event`. Omit for all namespaces. |
| `q` | string | Prefix match on `slug` and `title`. |
| `taggableType` | enum | `project` \| `person` \| `help_wanted_role`. Returns only tags that currently tag at least one item of this type. |
| `sort` | sort | Default `-projectCount`. Allowed: `title`, `projectCount`, `personCount`. |
| `page`, `perPage` | int | Default `perPage = 100`. |

### Response — 200

```json
{
  "success": true,
  "data": [Tag, ...]
}
```

### Tag shape (list)

```json
{
  "id": "<uuid>",
  "handle": "tech.flutter",                 // namespace.slug
  "namespace": "tech",
  "slug": "flutter",
  "title": "Flutter",
  "projectCount": 8,
  "personCount": 21,
  "helpWantedCount": 3
}
```

## GET /api/tags/:handle

`:handle` is `namespace.slug` (matches laddr URLs, e.g., `tech.flutter`).

### Response — 200

```json
{ "success": true, "data": Tag }
```

## POST /api/tags

Staff only. Used to seed new tags from the moderation UI.

### Request

```json
{ "namespace": "tech", "slug": "rust", "title": "Rust" }
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| namespace | yes | `topic` \| `tech` \| `event`. |
| slug | yes | `^[a-z0-9][a-z0-9-]{0,49}$`. Unique within namespace. |
| title | yes | 1–80 chars. |

### Response — 201

```json
{ "success": true, "data": Tag }
```

### Errors

- `409 conflict` — `(namespace, slug)` exists

## PATCH /api/tags/:handle

Edit `title`. Optional `mergeInto` field; if present, moves all TagAssignments to the target tag and deletes the source.

### Request

```json
{ "title": "Flutter (mobile)" }
```

or:

```json
{ "mergeInto": "tech.flutter" }
```

### Response — 200

```json
{ "success": true, "data": Tag }
```

### Errors

- `404 not_found` — handle doesn't exist
- `409 conflict` with `error.code = "merge_target_missing"` — `mergeInto` handle doesn't exist
- `409 conflict` with `error.code = "merge_namespace_mismatch"` — target is in a different namespace

## DELETE /api/tags/:handle

Hard delete. Cascades through `tag_assignments` (CASCADE on FK).

### Response — 204

## GET /api/tags/:handle/projects

Equivalent to `GET /api/projects?tag=<handle>` with the same response shape. Provided as a stable, discoverable URL for the `/tags/:namespace/:slug` web route.

## GET /api/tags/:handle/people

Equivalent to `GET /api/people?tag=<handle>`.

## Notes on the laddr migration

The laddr tag `Handle` was a single string like `topic.transit` or `tech.flutter`. On import we split on the first `.` and load `namespace = 'topic'`, `slug = 'transit'`. Tags with no `.` in their handle (a few legacy ones) become `namespace = 'topic'` by default and a staff curation pass moves them as needed.
