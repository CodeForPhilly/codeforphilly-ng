# Screen: Tags

## Routes

- `/tags` — public. Browse the full tag taxonomy.
- `/tags/:namespace` — public. Filter to one namespace (`topic`, `tech`, `event`).
- `/tags/:namespace/:slug` — public. Detail view for a single tag — projects + people that carry it.

The laddr URL form `/tags/<namespace>.<slug>` (e.g., `/tags/tech.flutter`) is preserved by a redirect handler that splits on the first `.` and 301s to the path form.

## Data Requirements

### `/tags` and `/tags/:namespace`

- `GET /api/tags` (with `?namespace=` for the filtered variant)
- Sort and paging match the API defaults

### `/tags/:namespace/:slug`

- `GET /api/tags/:handle` — tag header info
- `GET /api/projects?tag=:handle&perPage=12` — projects on this tag
- `GET /api/people?tag=:handle&perPage=12` — people on this tag
- `GET /api/help-wanted?tag=:handle&perPage=6` — open roles on this tag

## Display Rules

### `/tags` (overview)

- H1 "Tags"
- Three columns at ≥ md (stacked below), one per namespace:
  - **Topics** card — heading + top 10 tags as chips with counts, "See all topics →" link to `/tags/topic`
  - **Tech** card — same shape, "See all tech →" link to `/tags/tech`
  - **Events** card — same shape, "See all events →" link to `/tags/event`

### `/tags/:namespace` (one namespace)

- H1: "Topics", "Tech", or "Events"
- Search box: filter by `q` (prefix match)
- Sort dropdown: "Most projects" (default), "Most people", "A–Z"
- Grid of tag chips with counts. Click → `/tags/:namespace/:slug`
- Pagination if > perPage

### `/tags/:namespace/:slug` (detail)

- H1: tag title (e.g., "Flutter")
- Pill below H1: namespace label ("tech")
- Three sections:
  1. **Projects** — grid of up to 12 project cards (compact `ProjectListItem` rendering). "See all N projects →" link to `/projects?tag=:handle`.
  2. **Help-wanted** — list of up to 6 open roles (compact role cards). Hidden if zero open. "See all →" to `/help-wanted?tag=:handle`.
  3. **Members** — grid of up to 12 person cards (compact `PersonListItem` rendering). "See all N members →" link to `/members?tag=:handle`. Hidden for `event` namespace (events apply to projects only).

### 404

If `:namespace` is not one of the three known values or `:slug` doesn't resolve to a tag, render a 404 page with a "Browse all tags →" link.

## Actions

| Action | Effect |
| ------ | ------ |
| Tag chip click | Navigate to tag detail |
| Card click | Navigate to project / person / role |
| Search | URL `?q` + debounced re-fetch |
| Sort | URL state + re-fetch |
| Staff: "Edit tag" / "Merge into…" / "Delete" | Inline buttons on `/tags/:namespace/:slug` for staff — calls `PATCH /api/tags/:handle` or `DELETE`. Opens confirmation modals. |

## Navigation

**To here:** Every tag chip across the site, the projects-index and people-index "See all" links.

**From here:** Project detail, person detail, help-wanted index, projects index (with tag filter pre-applied).

## Authorization

Public for reading. Staff and administrators see inline edit/merge/delete controls on the detail page; everyone else doesn't.
