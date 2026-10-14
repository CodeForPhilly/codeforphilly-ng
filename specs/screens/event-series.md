# Screen: Event Series

## Route

`/events/series/:slug` — public. Rules in [behaviors/events.md#series](../behaviors/events.md#series).

## Data Requirements

- `GET /api/event-series/:slug` — the series with its `upcoming` and `past` event summaries
- `GET /api/auth/me`

Unknown slug, or a series whose events are all drafts and the caller isn't staff: 404 page.

## Display Rules

### Header

- Small muted "Event series" eyebrow
- H1 `title`
- `descriptionHtml` when present
- Staff controls, right-aligned: "Edit" opens an inline dialog for title, description, and (under "Advanced") slug; "New event in this series" → `/events/new?series=<slug>` (the form opens with the series preselected); "Delete" when `permissions.canDelete`, disabled with the tooltip "Remove its events from the series first" otherwise

### Upcoming

- Heading "Upcoming"
- The same event cards as [events-index.md](events-index.md#list), soonest first, without month headings (a series is already one heading)
- Empty: "Nothing scheduled yet in this series."

### Past

- Heading "Past"
- Same cards, most recent first, up to 50
- Empty: omitted entirely when there are no past events

## Actions

| Action | Affects | Caused by |
| ------ | ------- | --------- |
| Open an event | Navigation | Card |
| Edit series | `PATCH /api/event-series/:slug` | Staff dialog |
| New event in series | Navigation to the prefilled form | Staff control |
| Delete series | `DELETE /api/event-series/:slug`; navigates to `/events` | Staff control + confirm |

## Navigation

**To here:** "Part of <series>" on event detail; the events index does not list series in v1.

**From here:** `/events` (breadcrumb), `/events/<slug>`, `/events/new?series=<slug>`.

## Authorization

| Element | Anonymous | User | Staff |
| ------- | --------- | ---- | ----- |
| Page | visible | visible | visible, plus draft events with a "Draft" badge |
| Edit / New event / Delete | hidden | hidden | visible |
