# Screen: Blog Detail

## Route

`/blog/:slug` — public. A single blog post's full content.

## Data Requirements

- `GET /api/blog-posts/:slug` returning a `BlogPost` (with `bodyHtml`).
- 404 → catch-all NotFound screen. Slug-history redirects (per [behaviors/slug-handles.md](../behaviors/slug-handles.md)) take precedence over the 404 path once the redirect handler ships.

## Display Rules

### Header

- **Featured image** (if `featuredImageKey` set) full-width above the title.
- H1: the post's `title`.
- Byline directly below the title:
  - Author avatar (when non-null) + name (linked to `/members/:slug`)
  - `postedAt` formatted (e.g., "May 15, 2026")
  - If `editedAt` is set and differs from `postedAt` by more than a minute, show "Edited <relative-time>" subtly to the right.

### Body

- Render `bodyHtml` (server-rendered, sanitized) inside a typographic prose container — same styling as project detail's description region.
- External links open in a new tab per [behaviors/markdown-rendering.md](../behaviors/markdown-rendering.md) (when that landing transform ships).
- `@mention` of a member links to their profile per the same spec.

### Footer

- Tags carried on the post, rendered as clickable chips linking to `/blog?tag=<handle>`.
- "Back to all posts" link → `/blog`.

### Empty / edge

- A post whose `body` is empty renders just the header and an em-dash placeholder in the body region — never blank.

## Actions

| Action | Effect |
| ------ | ------ |
| Click author | Navigate to `/members/:slug`. |
| Click featured image | No action (no lightbox in v1). |
| Click tag chip | Navigate to `/blog?tag=<handle>`. |
| Click "Back to all posts" | Navigate to `/blog`. |

No edit / delete affordances — writes are via PR to the data repo.

## Navigation

**To here:** `/blog` index, person profile (recent posts by this author — future), tag pages.

**From here:** Person profile, tag pages, `/blog` index.

## Authorization

Public. Soft-deleted posts return 404 from the API.
