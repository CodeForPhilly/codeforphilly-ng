# Screen: Event Detail

## Route

`/events/:slug` — public. Rules in [behaviors/events.md](../behaviors/events.md).

Legacy laddr URLs of the same shape resolve directly because the backfilled historical events keep their slugs ([legacy-id-mapping.md](../behaviors/legacy-id-mapping.md)).

## Data Requirements

- `GET /api/events/:slug` — full Event with `viewerRsvp` and `permissions`
- `GET /api/events/:slug/rsvps?perPage=100` — attendee list (lazy after first paint)
- `GET /api/projects?perPage=100&sort=title` — only when the viewer is going, to populate the "Working on" selector (lazy, on first open of the selector)
- `GET /api/auth/me`

Unknown slug, or a draft and the caller isn't staff: 404 page.

## Display Rules

### Status banner

Across the top of the content area, before the title:

- `cancelled`: red strip "This event has been cancelled." followed by `cancellationNote` when present
- `draft` (staff only): yellow strip "Draft — only staff can see this event. [Publish]"
- Past (`endsAt ≤ now`, not cancelled): muted strip "This event has ended."

### Header

- H1 `title`
- **When** line, prominent: formatted per [behaviors/events.md#time](../behaviors/events.md#time), e.g. `Tuesday, November 3 · 6:00–8:30 PM EST`
- **Where** line:
  - `venueName` in bold, then `venueAddress` on the next line, the address linked to `https://maps.google.com/?q=<url-encoded venueName, venueAddress>` opening in a new tab
  - `onlineUrl` as "Join online" link when set (shown alongside the venue for hybrid events)
  - "Location to be announced" when neither is set
- Staff controls, right-aligned: "Edit" → `/events/<slug>/edit`; "Duplicate" → `/events/new?from=<slug>`; "Cancel event…" (confirm dialog with the optional note) when `permissions.canCancel`; "Delete" when `permissions.canDelete`

### Main column (two-thirds at lg, full below)

1. **RSVP block** — the primary call to action, directly under the header:

   | Viewer state | Rendered |
   | ------------ | -------- |
   | Anonymous, RSVPs open | Button "Sign in to RSVP" → `/login?return=/events/<slug>`; helper "Your name will appear on the attendee list." |
   | Signed in, not going, RSVPs open | Primary button "I'm going"; same helper text |
   | Signed in, going, RSVPs open | Success state "You're going ✓" with a quiet "Can't make it?" link that withdraws (confirm); below it the **Working on** selector: "Working on: [Pick a project ▾]" listing non-deleted projects by title with a "Clear" option; current choice shown as the selected value |
   | RSVPs closed (cancelled, past) | No control; the count line still renders |

   Under the control: "14 going" linked to the attendee list anchor. When `meetupUrl` is set, a small muted "Also listed on Meetup ↗" link sits *below* everything in this block, never beside the button.

   Clicking "I'm going" calls `PUT …/rsvp` with no body and swaps to the going state optimistically; on `409 rsvp_closed` it reloads the event. A toast confirms "You're going — check your email for a calendar invite." (or "…we couldn't send the calendar email, use Add to calendar below" when `confirmationDelivered = false`).

2. **Add to calendar** — a row of two links: "Add to Google Calendar" (prefilled template link, new tab) and "Download .ics" (`icsUrl`). Hidden for drafts.

3. **About** — `descriptionHtml`. Omitted entirely when the description is empty.

### Sidebar (one-third at lg, full below)

1. **Attendees** (`id="attendees"`)
   - Heading "Going (14)"
   - Grouped per [behaviors/events.md#rsvp-to-a-project](../behaviors/events.md#rsvp-to-a-project): a subheading per project (linked to `/projects/<slug>`) with that group's avatars (48px, name on hover, linked to `/members/<slug>`), then "Undecided" last. When nobody has picked a project, no subheadings — just the avatar grid.
   - Empty: "Nobody has RSVP'd yet. Be the first!" (or "Nobody RSVP'd." on past events)
   - For a cancelled event the heading reads "Had planned to go (14)"

2. **Share**
   - "Copy link" (copies `https://<host>/events/<slug>`)
   - "Share to Slack" — same mechanism as the project page

3. **Details**
   - "Added" relative time with absolute tooltip
   - "Updated" relative time when `updatedAt ≠ createdAt`

## Actions

| Action | Affects | Caused by |
| ------ | ------- | --------- |
| RSVP | `PUT /api/events/:slug/rsvp`; confirmation email | "I'm going" |
| Withdraw | `DELETE /api/events/:slug/rsvp` | "Can't make it?" + confirm |
| Pick / clear project | `PUT /api/events/:slug/rsvp` with `projectSlug` | "Working on" selector |
| Add to Google Calendar | Opens calendar.google.com template | Link |
| Download .ics | Downloads the file | Link |
| Publish | `POST /api/events/:slug/publish` | Draft banner button (staff) |
| Cancel | `POST /api/events/:slug/cancel` with optional note; attendees emailed | Staff control + dialog |
| Delete | `DELETE /api/events/:slug`; navigates to `/events` | Staff control + confirm; disabled with tooltip "Cancel instead — people have RSVP'd" when `canDelete = false` |
| Edit / Duplicate | Navigation | Staff controls |

## Navigation

**To here:** events index, home page upcoming-events section, emails (confirmation, reminders, update, cancellation link here), the `URL` property of the `.ics`, project pages' attendee groups, legacy `/events/<handle>` URLs.

**From here:** `/events` (breadcrumb), `/events/<slug>/edit`, `/events/new?from=<slug>`, `/projects/<slug>` (attendee groups, selector), `/members/<slug>` (avatars), `/login?return=…`, external: maps link, `onlineUrl`, `meetupUrl`, Google Calendar.

## Authorization

| Element | Anonymous | User | Staff |
| ------- | --------- | ---- | ----- |
| Page (scheduled / cancelled) | visible | visible | visible |
| Page (draft) | 404 | 404 | visible with draft banner |
| RSVP control | "Sign in to RSVP" | per table above | per table above |
| Attendee list | visible | visible | visible |
| Edit / Duplicate / Cancel / Delete / Publish | hidden | hidden | visible |

## Principles

**Inherited** — [behaviors/events.md#principles](../behaviors/events.md#principles): Philly time always; our RSVP is the call to action; RSVPs are public.

**Local** — owned by this screen:

- **One click to "going".** Anything that would put a form between the member and the RSVP (project choice, a message, a guest count) comes *after* the RSVP is recorded, or doesn't ship.
