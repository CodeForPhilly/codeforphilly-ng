# Screen: Help-Wanted Index

## Route

`/help-wanted` — public. New screen, no laddr equivalent.

## Data Requirements

- `GET /api/help-wanted` with URL query params
- `metadata.facets` powers the sidebar

### URL state

| URL param | Type | Meaning |
| --------- | ---- | ------- |
| `q` | string | Full-text on title + description |
| `tag` | string (repeatable) | `<namespace>.<slug>` |
| `commitmentMax` | int | "Show roles ≤ N hrs/week" |
| `sort` | string | Default `-createdAt` |
| `page` | int | |

`status` is fixed to `open` on this screen. To browse closed/filled, use the project-detail page's full list per project. (A staff variant `/help-wanted/all` is deferred.)

## Display Rules

### Header

- H1 "Help Wanted" with badge showing `metadata.totalItems`
- Intro paragraph: "Concrete, time-boxed ways to contribute to Code for Philly projects."
- Right side: "Post a role" button → opens a project picker (only projects the user can post help-wanted on are listed); clicking a project navigates to `/projects/:slug` with the post-role modal open. Visible to any user who maintains at least one project.

### Sidebar

- "Tech" tag rail (top 10 by count, with counts)
- "Topics" tag rail
- "Commitment" — radio group filter:
  - "Any" (default; clears `commitmentMax`)
  - "≤ 2 hrs/week" (`commitmentMax = 2`)
  - "≤ 5 hrs/week" (`commitmentMax = 5`)
  - "≤ 10 hrs/week" (`commitmentMax = 10`)

### Result cards

For each role:

- Card header: project title (linked) + "Help Wanted" small badge
- Role title (bold, large)
- Description (rendered markdown, truncated to 4 lines)
- Commitment chip ("~4 hrs/week" or "Flexible commitment")
- Tag chips
- Footer: poster avatar + name, "posted {relativeTime}"
- Right edge: "Express Interest" button (signed-in users only; replaced with "Sign in to express interest" link for anonymous)

Empty state: "No open roles match your filters." with a "Clear filters" button if any are active.

### Pagination

Same conventions as other index screens.

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| Filter | URL state | Re-fetch |
| Express interest | `POST /api/projects/:slug/help-wanted/:roleId/express-interest` (inline modal asks for optional message) | Button becomes "Interest Sent ✓"; refresh card state |
| Navigate to project | Navigation | – |
| Post a role | Picker → navigation to `/projects/:slug?openModal=help-wanted` | – |

## Navigation

**To here:** Home page rail, site nav (new entry "Help Wanted"), project detail "Help Wanted" links.

**From here:** `/projects/:slug`, `/tags/...`.

## Authorization

| Caller | Express interest | Post a role | Manage role status |
| ------ | :--------------: | :---------: | :----------------: |
| Anonymous | – | – | – |
| User | ✓ | only for projects they maintain | only for projects they maintain |
| Staff | ✓ | any project | any project |
| Administrator | ✓ | any project | any project |
