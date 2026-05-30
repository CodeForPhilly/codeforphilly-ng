# Screen: Blog Index

## Route

`/blog` — public. Reverse-chronological list of all (non-deleted) `BlogPost` records.

## Data Requirements

- `GET /api/blog-posts` with URL query params.
- Markdown is rendered server-side per [behaviors/markdown-rendering.md](../behaviors/markdown-rendering.md) — the API returns `bodyHtml` and `summary` (markdown) already; the SPA does not run a markdown library on user content.

### URL state

| URL param | Type | Meaning |
| --------- | ---- | ------- |
| `page`, `perPage` | int | `perPage` default 20. |
| `tag` | string (repeatable) | Filter to posts carrying this tag handle. |
| `since` | iso8601 | Only posts `postedAt >= since`. |

## Display Rules

### Header

- H1 "Blog"
- Subhead: "Long-form posts from the Code for Philly community."
- If `?tag=` is active, show the active tag chip(s) with a "Clear filter" button.

### List

- Post cards in reverse chronological order by `postedAt`, full-width.
- Each card displays:
  - **Featured image** (left, optional) when `featuredImageKey` is set — served via `GET /api/attachments/:key` (per [api/people.md](../api/people.md)).
  - **Title** (linked to `/blog/:slug`), as an H2.
  - **Byline**: author avatar + name (linked to person profile if author is non-null) + `postedAt` formatted (e.g., "May 15, 2026").
  - **Summary**: the post's `summary` field rendered as text; if absent, the first paragraph of `bodyHtml` truncated to ~280 chars.
- Pagination at the bottom (prev / numbered pages / next).

### Empty state

"No blog posts yet." — neutral copy; the importer hasn't run, or all posts are soft-deleted.

### Filtered empty state

"No posts match your filter. [Clear filter]"

## Actions

| Action | Effect |
| ------ | ------ |
| Click post title | Navigate to `/blog/:slug`. |
| Click author | Navigate to `/members/:slug`. |
| Click tag chip | Navigate to `/blog?tag=<handle>`. |
| Clear filter | Remove `tag` from URL. |
| Click page link | Update `page` query param. |

No mutations on this screen — writes happen via PR to the data repo.

## Navigation

**To here:** Footer link "Blog" — visible site-wide. Home page may also feature recent posts (out of scope here; future enhancement).

**From here:** `/blog/:slug` detail, person profiles, tag pages.

## Authorization

Public. Soft-deleted posts excluded by the API; this screen never sees them.
