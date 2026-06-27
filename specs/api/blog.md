# API: Blog Posts

Long-form posts authored by staff. Was laddr's `BlogPost`. See [data-model.md](../data-model.md#blogpost) for the entity shape.

Public reads only — writes happen via PR to the data repo (the content-typed gitsheets sheet's on-disk artifact is plain markdown with TOML frontmatter, so a PR is the editor). Per-author CMS writes are deferred to [#45](https://github.com/CodeForPhilly/codeforphilly-ng/issues/45).

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/blog-posts` | public | Paginated list of posts, newest `postedAt` first. |
| `GET` | `/api/blog-posts/:slug` | public | Fetch a single post by slug. |

## GET /api/blog-posts

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `page`, `perPage` | int | Default `perPage = 20`. |
| `tag` | string (repeatable) | Filter to posts carrying this tag (namespace.slug handle). |
| `since` | iso8601 | If present, only posts with `postedAt >= since`. |

### Response — 200

```json
{
  "success": true,
  "data": [BlogPost, ...],
  "metadata": { "page": 1, "perPage": 20, "totalPages": 3, "totalItems": 47 }
}
```

Soft-deleted records (`deletedAt != null`) are excluded.

## GET /api/blog-posts/:slug

### Response — 200

```json
{ "success": true, "data": BlogPost }
```

### Response — 404

Standard 404 envelope (per [conventions.md](conventions.md)). Slug-history redirects per [behaviors/slug-handles.md](../behaviors/slug-handles.md) apply once the slug-history redirect handler ships.

## BlogPost shape

```json
{
  "id": "<uuid>",
  "slug": "civic-tech-roundup-2026",
  "title": "Civic Tech Roundup, May 2026",
  "summary": "A short markdown blurb (max 500 chars), or null.",
  "author": PersonAvatar | null,    // null when authorId is absent or person was deleted
  "postedAt": "2026-05-15T18:00:00Z",
  "editedAt": "2026-05-16T09:30:00Z",  // null when unedited
  "featuredImageKey": "blog-posts/civic-tech-roundup-2026/cover.jpg",  // or null
  "featuredImageUrl": "/api/attachments/blog-posts/civic-tech-roundup-2026/cover.jpg",  // or null — derived from featuredImageKey
  "body": "Markdown source",
  "bodyHtml": "<p>...</p>",            // sanitized HTML, server-rendered
  "tags": [{ "namespace": "topic", "slug": "transit", "title": "Transit" }, ...],  // tags assigned to the post; [] when none
  "createdAt": "...",
  "updatedAt": "..."
}
```

`legacyId` is not exposed in the API response — clients don't need it, and surfacing it would invite churn when migrating off laddr.
