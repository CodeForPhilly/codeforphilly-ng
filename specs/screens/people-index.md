# Screen: People Index

## Route

`/members` — public. Replaces laddr's `/people` directory.

(The canonical URL is `/members` to match the legacy `/members/<slug>` convention. `/people` redirects to `/members`.)

## Data Requirements

- `GET /api/people` with URL query params
- `metadata.facets` powers the tag rails

### URL state

| URL param | Type | Meaning |
| --------- | ---- | ------- |
| `q` | string | Full-text on name + bio |
| `tag` | string (repeatable) | `<namespace>.<slug>` |
| `sort` | string | Default `-createdAt` |
| `page` | int | |

## Display Rules

### Header

- H1 "Members" with pill badge showing `metadata.totalItems`
- Search box (debounced 300ms)

### Sidebar (left, ≥ sm)

Tab strip: **Topics / Tech** — default Topics. (No "Events" or "Stages" — those don't apply to people.)

Active filter chips above the result grid.

### Result grid

Responsive grid — 4 cols ≥ lg, 3 cols ≥ md, 2 cols ≥ sm, 1 col below.

Each card:

- Avatar (large, square with rounded corners)
- Full name (linked to `/members/<slug>`)
- "Maintainer of N project(s)" if `memberOfCount > 0` (with maintainer count specifically; computed on the API as part of `PersonListItem`)
- Up to 3 top tags as chips
- Hover state lifts the card; whole card is clickable

When `data` is empty:

- With filters: "No members match your filters. [Clear]"
- Without filters: "No members yet."

### Pagination

Same conventions as projects index.

## Actions

| Action | Affects | Caused by |
| ------ | ------- | --------- |
| Apply/remove tag filter | URL state | Click chip |
| Search | Debounced URL state | Search box |
| Navigate to person | Navigation | Click card |
| Change sort | URL state | Sort dropdown |

## Navigation

**To here:** Site nav "Members", footer, author links from updates, project member avatars.

**From here:** `/members/<slug>`, `/tags/<namespace>/<slug>`.

## Authorization

| Caller | `accountLevel` filter | Staff fields |
| ------ | :-------------------: | :----------: |
| Anonymous | hidden | hidden |
| User | hidden | hidden |
| Staff | visible | visible |
| Administrator | visible | visible |
