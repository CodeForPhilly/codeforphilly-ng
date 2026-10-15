# Screen: Event Detail

## Route

`/events/:slug` — public. Rules in [behaviors/events.md](../behaviors/events.md).

Legacy laddr URLs of the same shape resolve directly because the backfilled historical events keep their slugs ([legacy-id-mapping.md](../behaviors/legacy-id-mapping.md)).

## Data Requirements

- `GET /api/events/:slug` — full Event with `viewerRsvp` and `permissions`
- `GET /api/events/:slug/rsvps?perPage=100` — attendee list (lazy after first paint)
- `GET /api/projects?q=<typed>&perPage=8` — only while the viewer is going and typing in the follow-up's project picker (lazy, debounced); the picker's opened-but-empty suggestions come from the event's `viewerRecentProjects` and `recentProjects`, already loaded
- `GET /api/auth/me`

Unknown slug, or a draft and the caller isn't staff: 404 page.

## Display Rules

### Status banner

Across the top of the content area, before the title:

- `cancelled`: red strip "This event has been cancelled." followed by `cancellationNote` when present
- `draft` (staff only): yellow strip "Draft — only staff can see this event. [Publish]"
- Past (`endsAt ≤ now`, not cancelled): muted strip "This event has ended."

### Header

- Above the H1, when `series` is set: small muted "Part of **<series title>**" linking to `/events/series/<slug>`
- H1 `title`
- **When** line, prominent: formatted per [behaviors/events.md#time](../behaviors/events.md#time), e.g. `Tuesday, November 3 · 6:00–8:30 PM EST`
- **Where** line:
  - `venueName` in bold, then `venueAddress` on the next line, the address linked to `https://maps.google.com/?q=<url-encoded venueName, venueAddress>` opening in a new tab
  - `onlineUrl` as "Join online" link when set (shown alongside the venue for hybrid events)
  - "Location to be announced" when neither is set
- Staff controls, right-aligned: "Edit" → `/events/<slug>/edit`; "Duplicate" → `/events/new?from=<slug>`; "Cancel event…" (confirm dialog with the optional note) when `permissions.canCancel`; "Delete" always shown to staff, disabled with the tooltip "Cancel instead — people have RSVP'd" when `permissions.canDelete` is false

### Main column (two-thirds at lg, full below)

1. **RSVP block** — the primary call to action, directly under the header:

   | Viewer state | Rendered |
   | ------------ | -------- |
   | Anonymous, RSVPs open | Button "Sign in to RSVP" → `/login?return=/events/<slug>`; helper "Your name will appear on the attendee list." |
   | Signed in, not going, RSVPs open | Primary button "I'm going"; same helper text |
   | Signed in, going, RSVPs open | Success state "You're going ✓" with an outline "Cancel RSVP" button beside it that withdraws (confirm dialog "Cancel your RSVP?" with "Keep my RSVP" and "Cancel RSVP"); below it the **follow-up** per [behaviors/events.md](../behaviors/events.md#the-follow-up-what-are-you-coming-to-do): the prompt "What are you coming to do? (optional)" with three choices — "I'm new to Code for Philly", "I don't have a project yet", "I'm coming to work on [Pick a project ▾]". The picker is a find-as-you-type combobox that never lists the whole catalog: opened with nothing typed, it offers two groups — "Your recent projects", the projects the member named on their own RSVPs to other events (`viewerRecentProjects`, newest first), then "Other active projects", the last ten distinct projects anyone named on any RSVP (`recentProjects`, newest first) — a project appearing once in the first group it belongs to, empty groups omitted, so a newcomer sees the teams that actually meet without searching; only when both are empty, nothing but the input's own hint "Type a project name"; once the member types, it searches projects by title and text (`GET /api/projects?q=`), showing at most eight in relevance order, or "No projects match". Arrow keys, Enter and Escape work as in any combobox. Selecting a choice saves immediately; the chosen one shows as selected with a "Change" affordance. Unanswered shows the three choices; never a blank. |
   | RSVPs closed (cancelled, past) | No control; the count line still renders |

   Under the control: "14 going" linked to the attendee list anchor. When `meetupUrl` is set, a small muted "Also listed on Meetup ↗" link sits *below* everything in this block, never beside the button.

   Clicking "I'm going" calls `PUT …/rsvp` with no body and swaps to the going state optimistically; on `409 rsvp_closed` it reloads the event. A toast confirms "You're going — check your email for a calendar invite." (or "…we couldn't send the calendar email, use Add to calendar below" when `confirmationDelivered = false`).

2. **Add to calendar** — a row of two links: "Add to Google Calendar" (prefilled template link, new tab) and "Download .ics" (`icsUrl`). Hidden for drafts.

3. **About** — `descriptionHtml`. Omitted entirely when the description is empty.

4. **Schedule** (`id="schedule"`) — only when `agenda` is non-empty; on screens below lg it renders here, after About, and a "See the schedule ↓" jump link sits under the When line. At lg and above it moves to the top of the sidebar. Rendering per [behaviors/events.md#agenda](../behaviors/events.md#agenda): day headings (`**Friday,** March 31`), per item a compact time range, the title, the `descriptionHtml`, and a map-pin venue line (Google Maps link) only when the venue differs from the previous item that day.

### Sidebar (one-third at lg, full below)

0. **Schedule** — at lg and above, the agenda block described in the main column renders here first.

1. **Attendees** (`id="attendees"`)
   - Heading "Going (14)"
   - Grouped per [behaviors/events.md](../behaviors/events.md#the-follow-up-what-are-you-coming-to-do): a subheading per project (linked to `/projects/<slug>`) with that group's avatars (48px, name on hover, linked to `/members/<slug>`), The members who haven't answered come first, as an avatar grid with no subheading directly under "Going (N)"; then a subheading per project (linked to `/projects/<slug>`) with that group's avatars (48px, name on hover, linked to `/members/<slug>`), then "New to Code for Philly" and "No project yet", each only when non-empty. When nobody has answered the follow-up, that first grid is the whole list.
   - Empty: "Nobody has RSVP'd yet. Be the first!" (or "Nobody RSVP'd." on past events)
   - For a cancelled event the heading reads "Had planned to go (14)"

2. **Share**
   - "Copy link" (copies `https://<host>/events/<slug>`)
   - "Share to Slack" — same mechanism as the project page; the copied message is `<title> — <when>: <canonical URL>`

3. **Details**
   - "Added" relative time with absolute tooltip
   - "Updated" relative time when `updatedAt ≠ createdAt`

## Actions

| Action | Affects | Caused by |
| ------ | ------- | --------- |
| RSVP | `PUT /api/events/:slug/rsvp`; confirmation email | "I'm going" |
| Withdraw | `DELETE /api/events/:slug/rsvp` | "Cancel RSVP" + confirm |
| Answer / change the follow-up | `PUT /api/events/:slug/rsvp` with `plan` (+ `projectSlug`) | Follow-up choices |
| Add to Google Calendar | Opens calendar.google.com template | Link |
| Download .ics | Downloads the file | Link |
| Publish | `POST /api/events/:slug/publish` | Draft banner button (staff) |
| Cancel | `POST /api/events/:slug/cancel` with optional note; attendees emailed | Staff control + dialog |
| Delete | `DELETE /api/events/:slug`; navigates to `/events` | Staff control + confirm; disabled with tooltip "Cancel instead — people have RSVP'd" when `canDelete = false` |
| Edit / Duplicate | Navigation | Staff controls |

## Navigation

**To here:** events index, home page upcoming-events section, emails (confirmation, reminders, update, cancellation link here), the `URL` property of the `.ics`, project pages' attendee groups, legacy `/events/<handle>` URLs.

**From here:** `/events` (breadcrumb), `/events/series/<slug>` ("Part of"), `/events/<slug>/edit`, `/events/new?from=<slug>`, `/projects/<slug>` (attendee groups, picker), `/members/<slug>` (avatars), `/login?return=…`, external: maps links, `onlineUrl`, `meetupUrl`, Google Calendar.

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
