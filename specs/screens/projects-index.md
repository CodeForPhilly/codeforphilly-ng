# Screen: Projects Index

## Route

`/projects` — public. Replaces laddr's `/projects` browse page.

## Data Requirements

- `GET /api/projects` with the query params reflecting the URL state (see below)
- The response's `metadata.facets` powers the tag/stage rails
- `GET /api/auth/me` — for the "Add Project" CTA

### URL state

Filters are reflected in the query string. Sharable, back/forward-friendly.

| URL param | Type | Meaning |
| --------- | ---- | ------- |
| `q` | string | Full-text search |
| `tag` | string (repeatable) | `<namespace>.<slug>` |
| `stage` | string (csv) | One or more stages |
| `helpWanted` | bool | Only projects with open roles |
| `sort` | string | Default `-updatedAt` |
| `page` | int | |

## Display Rules

### Header

- H1: "Civic Projects Directory" with a pill badge showing `metadata.totalItems`
- Right side: "Add Project" button — visible to signed-in users (matches laddr precedent where any user could add a project)
- Subhead paragraph and intro content from a static `projects-browse-introduction` content block; v1 hard-codes the current copy (see laddr `html-templates/projects/projects.tpl` line 24 reference)

### Sidebar (left, ≥ sm)

Tab strip across the top of the sidebar: **Topics / Tech / Events / Stages** — default Topics.

For each tab:

- **Topics, Tech, Events** — list of tag chips with item count. Each links to the same projects page with that tag added. Top 10 by count (from `metadata.facets`). "See all →" links to `/tags?namespace=topic` (etc).
- **Stages** — list of all 7 stages with count and color matching [behaviors/project-stages.md](../behaviors/project-stages.md). Clicking adds that stage to the `stage` filter.

Multi-select: clicking an already-active filter chip removes it. Active filters are visually distinguished (filled vs outlined).

Active filters surface as removable chips below the H1, "Filters: [Tech: Flutter ×] [Stage: Prototyping ×] Clear all".

### Sort control

A dropdown at the right of the filter chip row:

- "Recently updated" (default)
- "Recently created"
- "Title A–Z"
- "Stage" (Maintaining → Hibernating, matches the rank in [behaviors/project-stages.md](../behaviors/project-stages.md))

### Search box

Above the cards, full-width: "Search projects…" → debounced (300ms) update to `q`.

### Result cards

For each project (ProjectListItem):

- **Title** — linked to `/projects/<slug>`
- **Stage badge** — color per [behaviors/project-stages.md](../behaviors/project-stages.md)
- **Summary or overviewExcerpt** — `summary` if set, otherwise `overviewExcerpt` (truncated to 600 chars, server-rendered markdown stripped to plain text)
- **Member avatars** — `members` (max 10, maintainer largest at 64px, others 48px), ordered by `isMaintainer DESC, role asc, fullName asc`. Hover/tooltip shows name + role.
- **Tag chips** — up to 5, mixed namespaces, color-coded by namespace. "+N more" for additional tags.
- **Action buttons** — "Public Site" if `usersUrl`, "Developers" if `developersUrl`, "Chat" if `chatChannel`
- **Help-wanted badge** — if `openHelpWantedCount > 0`, a yellow pill "Help wanted (3)" linking to the project page anchored at the help-wanted section

When `data` is empty:

- If any filters are active: "No projects match your filters. [Clear all]"
- If no filters and zero projects: "No projects yet — be the first to add one!"

### Pagination

Bottom of the list. Standard prev / 1 2 3 … N / next. Hidden when `totalPages ≤ 1`.

## Actions

| Action | Affects | Caused by |
| ------ | ------- | --------- |
| Apply tag filter | URL state + re-fetch | Click tag chip |
| Apply stage filter | URL state + re-fetch | Click stage chip |
| Remove filter | URL state + re-fetch | Click `×` on active chip |
| Clear all filters | URL state + re-fetch | Click "Clear all" |
| Change sort | URL state + re-fetch | Sort dropdown |
| Search | Debounced URL state + re-fetch | Type in search box |
| Navigate to project | Navigation | Click project title or card |
| Add project | Navigation to `/projects/create` (form spec lives in `screens/project-edit.md`) | "Add Project" button |

## Navigation

**To here:** Home page links, footer "Active Projects", site nav "Projects", every tag chip everywhere.

**From here:** `/projects/<slug>`, `/projects/create`, `/members/<slug>`, `/tags/<namespace>/<slug>`.

## Authorization

| Caller | "Add Project" | Soft-deleted projects | Featured-toggle controls |
| ------ | :-----------: | :-------------------: | :----------------------: |
| Anonymous | hidden | hidden | hidden |
| User | visible | hidden | hidden |
| Staff | visible | visible (with badge) | visible (inline toggle) |
| Administrator | visible | visible | visible |

Staff users see an `?includeDeleted=true` toggle in the sort row.
