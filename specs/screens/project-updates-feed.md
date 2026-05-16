# Screen: Project Updates Feed

## Route

`/project-updates` — public. Global reverse-chronological feed of all `ProjectUpdate` rows across all projects.

The single-update permalink lives at `/projects/:slug/updates/:number` and is not a separate screen — it's a project-detail variant that anchors to and highlights one update.

## Data Requirements

- `GET /api/project-updates` with URL query params
- Activity rendering uses the [activity-feed behavior](../behaviors/activity-feed.md), specifically the **Update card** variant

### URL state

| URL param | Type | Meaning |
| --------- | ---- | ------- |
| `tag` | string (repeatable) | Filter to updates whose project carries this tag |
| `since` | iso8601 | Only updates `createdAt >= since` |
| `page`, `perPage` | int | `perPage` default 20 |

## Display Rules

### Header

- H1 "Project Updates"
- Subhead: "What's happening across our 268 projects."
- Right side: tag chip filter (active filters) + Clear all
- Below header, a "Subscribe" disclosure that explains where RSS used to live and links to [deferred.md](../deferred.md) status (or, when RSS is restored, the actual feed URL)

### List

- Update cards in reverse chronological order, full width
- Each card includes the project name (linked) — this feed mixes updates from different projects
- Pagination at the bottom (prev / pages / next)

### Empty state

"No updates posted yet on this site." — extremely unlikely with seeded data.

### Filtered empty state

"No updates match your filter. [Clear filter]"

## Actions

| Action | Effect |
| ------ | ------ |
| Click project title | Navigate to project detail |
| Click author | Navigate to person profile |
| Click update permalink | Navigate to project's updates list page (anchor on this number) |
| Apply tag filter | URL state + re-fetch |
| Remove tag filter | URL state + re-fetch |

No mutations on this screen. Editing and deleting updates happens on the project detail page where the caller can be authorized as `author | staff`.

## Navigation

**To here:** Home page activity stream "View all activity" link, footer link.

**From here:** Project detail pages, member profiles, tag pages.

## Authorization

Public. Soft-deleted projects' updates are excluded.
