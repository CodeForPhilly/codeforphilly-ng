# Screen: Project Buzz Feed

## Route

`/project-buzz` — public. Global feed of all `ProjectBuzz` rows.

## Data Requirements

- `GET /api/project-buzz` with URL query params
- Activity rendering uses the [activity-feed behavior](../behaviors/activity-feed.md), specifically the **Buzz card** variant

### URL state

| URL param | Type | Meaning |
| --------- | ---- | ------- |
| `tag` | string (repeatable) | Filter to buzz whose project carries this tag |
| `since` | iso8601 | Only buzz with `publishedAt >= since` |
| `page`, `perPage` | int | `perPage` default 30 |

## Display Rules

### Header

- H1 "In the press"
- Subhead: "Articles, mentions, and external posts about Code for Philly projects."

### List

- Buzz cards in reverse chronological order by `publishedAt` (matches activity-feed merge key)
- Each card shows project name, headline (linking out to source), source hostname, publication date, summary if present, and thumbnail if `imageUrl` is set

### Empty state

"No buzz logged yet."

### Filtered empty state

"No buzz matches your filter. [Clear filter]"

## Actions

| Action | Effect |
| ------ | ------ |
| Click headline | Navigate to **external** URL (new tab) |
| Click project title | Navigate to project detail |
| Click permalink "View on site" | Navigate to `/projects/:slug/buzz/:buzzSlug` |
| Apply tag filter | URL state + re-fetch |

## Navigation

**To here:** Footer link, home page activity stream "Buzz" filter chip → "View all" link.

**From here:** External URLs (primary), project detail pages, tag pages.

## Authorization

Public. Soft-deleted projects' buzz is excluded.
