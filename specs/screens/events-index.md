# Screen: Events Index

## Route

- `/events` — upcoming events. Public.
- `/events/past` — past events. Public.
- `/calendar` — 301 to `/events` (the issue asked for either name; both work).

Rules in [behaviors/events.md](../behaviors/events.md).

## Data Requirements

- `GET /api/events?when=upcoming&perPage=50` on `/events`; `GET /api/events?when=past&perPage=30&page=N` on `/events/past`
- `GET /api/auth/me` — staff controls and the viewer's RSVP badges

## Display Rules

### Header

- H1 "Events"
- Lead paragraph: "Code for Philly meets in person every month. RSVP so we know you're coming, and subscribe to get every event on your own calendar."
- Right-aligned controls:
  - "Subscribe to calendar" — a `webcal://<host>/api/events/feed.ics` link with a copy-to-clipboard fallback for browsers that don't register the scheme
  - "New event" button → `/events/new` — staff only

### View switch

Two tab-style links under the header: **Upcoming** (`/events`) and **Past** (`/events/past`). The active one is marked; both are plain links so they deep-link.

### List

Events grouped under month headings (`November 2026`), in the order the API returns them (soonest first on Upcoming, most recent first on Past). Each event is a card:

- **Date block** on the left: weekday abbreviation, day number, month abbreviation — all in `America/New_York`
- Title, linked to `/events/<slug>`
- Time line: `6:00–8:30 PM EST` (multi-day events show the full range per [behaviors/events.md#time](../behaviors/events.md#time))
- Where line: `venueName` if set; else "Online" if `onlineUrl`; else "Location TBA". A venue with both renders `venueName · Online option`
- Attendance: "14 going"; when the viewer has an RSVP, "You're going ✓" replaces the count's lead ("You're going ✓ · 14 going")
- Badges: "Cancelled" when `status = cancelled` (card otherwise rendered muted); "Draft" when `status = draft` (staff only see these)
- The whole card links to the detail page

### Pagination

- Upcoming: one page is enough; the list is bounded by how far ahead staff schedule. No pager.
- Past: "Load more" button plus `?page=N` support, same as the feed pages.

### Empty states

- Upcoming, nothing scheduled: "Nothing on the calendar yet. Join the Slack and watch #announcements — or check back soon." with a link to `/chat`. Staff additionally see the "New event" button repeated in the empty state.
- Past, nothing: "No past events yet."

## Actions

| Action | Affects | Caused by |
| ------ | ------- | --------- |
| Open an event | Navigation | Card click |
| Switch Upcoming / Past | Navigation | Tab links |
| Subscribe to calendar | Opens the calendar app via `webcal://`, or copies the `https://` URL | Header control |
| New event | Navigation to `/events/new` | Staff button |

## Navigation

**To here:** header "Events" link, footer "Events" link, home page "See all events →", event detail breadcrumb, legacy `/events/*past` and `/events/*upcoming` and `/events/*all` redirects ([legacy-id-mapping.md](../behaviors/legacy-id-mapping.md)).

**From here:** `/events/<slug>`, `/events/past`, `/events/new` (staff), `/chat`.

## Authorization

| Element | Anonymous | User | Staff |
| ------- | --------- | ---- | ----- |
| Upcoming / past lists | visible | visible | visible, plus drafts with a "Draft" badge |
| "You're going ✓" | never | when RSVP'd | when RSVP'd |
| "New event" | hidden | hidden | visible |

## Principles

**Local** — owned by this screen:

- **The next event is the point of this page.** When layout decisions compete, favor making the soonest upcoming event the most prominent thing on screen. A month grid, filters, or search would push it down; none ship until the list outgrows a single screen.
