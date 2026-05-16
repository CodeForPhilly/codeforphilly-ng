# Behavior: Activity Feed

## Rule

A unified, reverse-chronological stream of "things that happened on a project" — composed of `ProjectUpdate` and `ProjectBuzz` items, optionally filterable to one type. Used wherever the site shows activity: home page, project detail, global feeds.

## Applies To

- [screens/home.md](../screens/home.md) — Latest Project Activity section
- [screens/project-detail.md](../screens/project-detail.md) — Project Activity section
- [screens/project-updates.md](../screens/project-updates.md), [screens/project-buzz.md](../screens/project-buzz.md) — single-type browse pages
- [api/projects-updates.md](../api/projects-updates.md), [api/projects-buzz.md](../api/projects-buzz.md) — feeds delivered via per-type endpoints

## Item types

Two card variants for now; the design allows adding more (e.g., "new member joined") later without changing consumers.

### Update card

Shown when the item is a `ProjectUpdate`.

- Header line: `<project title>` (linked) + " · Update #N" (linked to the permalink `/projects/:slug/updates/:number`)
- Author row: avatar + name (linked) + relative time (with absolute as tooltip)
- Body: rendered `bodyHtml`, truncated to ~5 lines with "Read more" expanding inline
- Footer: subtle action row — "Open update" (permalink); when caller is author/staff also "Edit" and "Delete"

### Buzz card

Shown when the item is a `ProjectBuzz`.

- Header line: `<project title>` (linked) + " · Buzz" + " · " + `publishedAt` (absolute, formatted as `MMM d, yyyy`)
- Headline as H3, linked to the **external URL** in a new tab (not to a site permalink — the buzz card's purpose is to drive traffic to the external article)
- Below headline: hostname of the URL ("inquirer.com") as a small label
- If `imageUrl`: thumbnail to the left (96x96)
- Summary if present, truncated to ~3 lines
- Footer: "Logged by {person}" + small "View on site" permalink to `/projects/:slug/buzz/:buzzSlug`

## Composition

When a feed is requested with both types, the implementation can either:

- Query both endpoints and merge client-side, or
- Provide a server-side "combined" endpoint

v1 takes the **client-side merge** approach: home page calls `GET /api/project-updates?perPage=10` and `GET /api/project-buzz?perPage=10` in parallel, merges by `createdAt` (for updates) / `publishedAt` (for buzz), and truncates to 10 total. Project detail calls `GET /api/projects/:slug/updates` and `GET /api/projects/:slug/buzz`.

Server-side, both endpoints serve from the in-memory store via the secondary indices documented in [data-model.md](../data-model.md) (`updatesByProject`, `buzzByProject`, plus their global-feed equivalents). No on-disk scan or query planner — just JS array slice + sort. See [behaviors/storage.md](storage.md).

The merge key for sorting:

- Update → `createdAt`
- Buzz → `publishedAt` (the date the external article ran), not `createdAt` (when the row was logged). This means a freshly logged 2-year-old buzz item lands in the right place historically.

## Filter chips

Where the feed has filter chips (home, global feeds):

- "All" (default) — both types, merged
- "Updates" — only ProjectUpdate
- "Buzz" — only ProjectBuzz

Switching chips:

- Home page: client-side filter of already-loaded items (10 of each). No re-fetch.
- Global feed pages: URL state + re-fetch from the corresponding endpoint.

## Pagination

Activity is reverse-chronological infinite scroll on the dedicated feed pages, fixed-size lists everywhere else. The "load more" button is preferred over scroll-jacking; both feed pages support a `?page=N` URL param so deep links are stable.

## Empty state

- Project detail: "This project doesn't have any activity yet, post an update or log some buzz!" with action buttons for both, gated by permissions.
- Home: "No project activity yet on the site." — extremely unlikely with seeded data, but specified.
- Global feed: same as home.

## Future extensions (out of scope for v1)

Tracked here so the design accommodates them without redoing the schema:

- **New member joined** card — fires when a `ProjectMembership` is created. Generated, not stored.
- **Project stage changed** card — fires when `Project.stage` changes via PATCH.
- **Help-wanted role posted** card — fires on `HelpWantedRole` creation.
- **Project created** card — fires on project creation.

These would be generated on read by combining database rows, not stored as discrete `activity` rows. If activity volume grows enough to need a materialized feed table, that's the cue to revisit.
