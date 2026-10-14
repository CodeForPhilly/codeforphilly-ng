# Behavior: Events

## Rule

An **event** is a single, dated gathering Code for Philly hosts — a monthly hack night, a showcase, a workshop. Staff create them on the site, members RSVP on the site, and the site is the system of record for when, where, and who's going. Meetup.com is no longer the source of truth; while the community transitions, an event may carry a link to its Meetup listing, but the site's own RSVP is always the primary call to action.

This is the scope [issue #194](https://github.com/CodeForPhilly/codeforphilly-ng/issues/194) asks for: an easy-to-remember `/events` page, member RSVPs, calendar files, reminder emails, and a short list on the home page. Events are **flat** — one record is one thing you RSVP to — and two optional structures hang off them: a [series](#series) ("Monthly Hack Nights") and an [agenda](#agenda) (the timed schedule inside a big event). Together they cover what laddr's program-with-sessions model did for Launchpad without making sessions their own records.

## Applies To

- [data-model.md#event](../data-model.md#event), [data-model.md#eventrsvp](../data-model.md#eventrsvp), [data-model.md#eventseries](../data-model.md#eventseries-new)
- [api/events.md](../api/events.md)
- [screens/events-index.md](../screens/events-index.md), [screens/event-detail.md](../screens/event-detail.md), [screens/event-edit.md](../screens/event-edit.md), [screens/event-series.md](../screens/event-series.md)
- [screens/home.md](../screens/home.md) — Upcoming events section
- [behaviors/app-shell.md](app-shell.md) — "Events" nav item, breadcrumbs

## Time

- Every event has a `startsAt` and an `endsAt`, stored as ISO 8601 UTC like every other timestamp.
- **Events are displayed in `America/New_York`** — always, regardless of the viewer's browser zone. The site's events happen in Philadelphia; a member travelling should still read "6:00 PM" and know it means Philly time. Rendered times carry the zone abbreviation ("6:00 PM EST", "6:00 PM EDT") so nobody has to guess.
- The staff form takes wall-clock times in `America/New_York` and the client converts to UTC before calling the API. The API accepts and returns UTC only.
- `endsAt` is required and must be after `startsAt`. The form defaults it to `startsAt + 2.5 hours` — the length of a hack night — so a staff member usually only types the start.
- Display format, used everywhere an event's time appears (cards, detail, emails, ICS `SUMMARY` is excluded):
  - Same-day event: `Tue, Nov 3 · 6:00–8:30 PM EST`
  - Multi-day event: `Fri, Mar 31, 6:00 PM – Wed, May 10, 9:00 PM EDT`
  - A multi-day event that crosses a DST change labels both ends: `Sat, Nov 1, 6:00 PM EDT – Sun, Nov 2, 9:00 AM EST`.
  - Year is appended (`Nov 3, 2025`) only when the event is not in the current calendar year.

## Upcoming vs past

An event is **upcoming** while `endsAt > now` and **past** once `endsAt ≤ now`. The boundary is the *end*, not the start, so an event in progress still appears under upcoming and still accepts RSVPs (see [RSVP window](#rsvp-window)). Laddr used the same rule.

- Upcoming lists sort by `startsAt` ascending (soonest first).
- Past lists sort by `startsAt` descending (most recent first).

## Status lifecycle

```text
            publish                cancel
  draft ───────────▶ scheduled ───────────▶ cancelled
    │
    └──── delete (hard) ────▶ gone
```

| Status | Visible to | Accepts RSVPs | Set when |
| ------ | ---------- | ------------- | -------- |
| `draft` | staff only | no | Created with `status: draft`. Never listed publicly, never in the feed, direct URL is 404 to non-staff. |
| `scheduled` | everyone | yes, within the window | Created with `status: scheduled` (the form's default) or via `publish`. |
| `cancelled` | everyone | no | `cancel` was called. The record keeps everything it had plus `cancelledAt` and an optional `cancellationNote`. |

- Transitions are explicit endpoints (`publish`, `cancel`), not a `status` field on PATCH — same reasoning as [help-wanted roles](help-wanted-roles.md#status-lifecycle): a clean audit trail and an obvious UI.
- There is no un-cancel. If an event comes back, staff duplicate it (see [Duplicating](#duplicating)) — the cancelled record stays as history and its attendees were already told.
- Cancelled events remain in lists and at their URL with a prominent "Cancelled" treatment. Hiding them would leave someone who saw the event last week wondering where it went.
- **Hard delete** is allowed only while the event is `draft` or has zero RSVPs. Otherwise the API refuses (`409 has_rsvps`) and the answer is `cancel`. Deleting removes the event and its RSVP records in one commit; git history keeps the audit.

## Series

An **event series** is a named grouping with no dates of its own: "Monthly Hack Nights", "Launchpad", "Open Data Workshops". An event belongs to at most one series (`seriesId`), and a series has any number of events across any span of time.

- A series is **not** a recurrence rule and generates nothing. It is a label with a page. The [One record per occurrence](#principles) principle stands: every hack night is still its own record.
- The event detail page shows "Part of <series title>" linking to `/events/series/<slug>`; the series page lists its upcoming events first, then past, with the series description above.
- Duplicating an event keeps its series. That is how the monthly hack night accumulates under one heading with no extra typing.
- Staff manage series from the event form (pick an existing one or create inline) and from the series page (edit title and description). A series can be deleted only when no event references it.
- Series are visible wherever their events are; a series with only drafts is reachable to staff only.

## Agenda

An event may carry an **agenda**: an ordered list of timed items embedded in the record (laddr's `EventSegment`, without the separate table). A hack night has none. A Launchpad weekend has a dozen.

- Each item has a start time, an optional end, a title, an optional venue override, and an optional markdown description. Items sit within the event's own time range and are kept sorted by start.
- The detail page renders a non-empty agenda as the **Schedule** sidebar, grouped by day in `America/New_York` ("**Friday,** March 31"), each item showing its compact time range ("6–9pm", "9am–7pm"), its title, and its description. A venue is shown with a map-pin and a Google Maps link only when it differs from the previous item's venue, where an item without a venue override is at the event's venue and each day starts from the event's venue — this is laddr's schedule sidebar, which was the best piece of the old UI.
- Agenda items have no identity: no slug, no page, no RSVP, no reminder. "Going to Showcase Night" means RSVPing to the event that contains it. If a session genuinely needs its own RSVP list, it becomes its own event in the same series ([deferred.md](../deferred.md#per-session-rsvps-on-multi-day-events)).
- The agenda is **not** exported as separate calendar entries; the event's `.ics` `DESCRIPTION` includes a plain-text rendering of the schedule after the description.
- Agenda edits bump nothing and email nobody. Only the event-level time and location fields trigger the "event updated" mail.

## RSVP

An RSVP is a public statement by a signed-in member that they're coming. It is **binary**: an `EventRsvp` record exists (going) or it doesn't. There is no "maybe" and no stored "not going" — withdrawing an RSVP deletes the record. Meetup dropped "maybe" years ago for the same reason: it tells organizers nothing.

### Who can RSVP

Any signed-in person (`user`). Anonymous visitors see the RSVP control as "Sign in to RSVP", which routes through `/login?return=/events/<slug>`. There is no guest or email-only RSVP: creating an account is GitHub sign-in, which the issue thread agreed is fast enough (and leaves the newcomer ready to join projects).

### RSVP window

RSVPs are accepted from the moment an event is `scheduled` until `endsAt`. Accepting RSVPs *during* the event is deliberate — it is the lightweight successor to laddr's check-in: someone who shows up unannounced can tap "I'm going" from the door and appear on the attendee list. After `endsAt`, and for `draft` or `cancelled` events, the API answers `409 rsvp_closed` and the UI shows no control.

### RSVPs are public

RSVP records live in the public data repo and the attendee list on the event page shows every going member by avatar and name, exactly as Meetup did. The UI never implies otherwise: the RSVP control's helper text reads "Your name will appear on the attendee list." Members who don't want to be listed simply don't RSVP. A private RSVP that writes a supplemental record to the private store is a documented future ([deferred.md](../deferred.md#private-rsvps)); until it exists there is no private RSVP.

### The follow-up: what are you coming to do?

"I'm going" is always one click. *After* it lands, the attendee sees one optional follow-up question, phrased so a newcomer has an answer that isn't "pick a project":

| Choice | `EventRsvp.plan` | Attendee list group |
| ------ | ---------------- | ------------------- |
| "I'm new to Code for Philly" | `newcomer` | **New to Code for Philly** |
| "I don't have a project yet" | `no_project` | **Looking for a project** |
| "I'm coming to work on …" + project picker | `project` + `projectId` | the project |
| *(unanswered)* | absent | **Not sure yet** |

The answer can be changed any time while the RSVP window is open and never sends mail. The point is organizational, not gatekeeping: the attendee list groups going members by project (ordered by attendee count, then title), then **New to Code for Philly**, then **Looking for a project**, then **Not sure yet**. Organizers see at a glance who to welcome at the door and which tables will be full; newcomers see that they won't be the only new face. This is what laddr's check-in-by-project did well, with the newcomer case made explicit.

### Side effects of RSVPing

- Creating an RSVP sends the member a **confirmation email** with the event's `.ics` attached and an "Add to Google Calendar" link (see [Calendar files](#calendar-files)). Answering or changing the follow-up on an existing RSVP sends nothing.
- Withdrawing sends nothing.
- Email is fire-and-forget: the RSVP write succeeds and the API responds whether or not the email was delivered, per the established notifier contract ([architecture.md](../architecture.md)). The response's `data.confirmationDelivered` reports what the notifier returned.

## Calendar files

Every scheduled or cancelled event is representable as an iCalendar `VEVENT`:

| iCal property | Source |
| ------------- | ------ |
| `UID` | `<event.id>@codeforphilly.org` — stable for the life of the record so calendars update in place |
| `SEQUENCE` | `event.icsSequence` |
| `DTSTAMP` | `event.updatedAt` |
| `DTSTART` / `DTEND` | `startsAt` / `endsAt` in UTC (`Z` form); calendar apps localize |
| `SUMMARY` | `title` |
| `DESCRIPTION` | plain-text rendering of `description` (markdown stripped), followed by a blank line and the event's canonical URL |
| `LOCATION` | `venueName`, then `", "` + `venueAddress` when present; else `onlineUrl`; else omitted |
| `URL` | `https://<CFP_SITE_HOST>/events/<slug>` |
| `STATUS` | `CONFIRMED` for `scheduled`; `CANCELLED` for `cancelled` |

`icsSequence` starts at 0 and increments whenever any of `title`, `startsAt`, `endsAt`, `venueName`, `venueAddress`, `onlineUrl` changes, and on cancel. A client that already holds the earlier `UID` replaces its copy when it sees a higher `SEQUENCE`; this is what makes the "event updated" email actually move the entry on someone's calendar.

Three delivery forms, all `METHOD:PUBLISH`:

1. **Attachment** on the confirmation, update, and cancellation emails (`<slug>.ics`, `text/calendar`).
2. **Download** — `GET /api/events/:slug/ics` behind the "Download .ics" control.
3. **Subscription feed** — `GET /api/events/feed.ics`, one `VCALENDAR` of every scheduled and cancelled event from 90 days ago onward, with `X-WR-CALNAME: Code for Philly`. The index page offers it as a `webcal://` link so a member can subscribe once and never look at the site for dates again. Drafts never appear.

The "Add to Google Calendar" control is a prefilled `calendar.google.com/calendar/render?action=TEMPLATE` link carrying title, UTC `dates`, plain-text details with the canonical URL, and the same `LOCATION` string. It is a convenience link, not a feed.

## Reminders

Attendees get two reminder emails per event: **one week before** and **one day before** `startsAt`.

- A background sweep runs in-process every 5 minutes (the same shape as the revocation sweeper in [authorization.md](authorization.md#revocation)). Single replica, so one sweep. It runs *inside* the API process rather than as a Kubernetes CronJob or an Actions cron because the bookkeeping write has to go through the in-process write mutex ([storage.md](storage.md)); a separate process could only write by pushing a commit to the data repo and waiting for hot reload, which is a roundabout way to set one timestamp.
- The week reminder is **due** for a `scheduled` event when `startsAt − 7d ≤ now < startsAt − 6d` and `reminders.weekSentAt` is unset. The day reminder is due when `startsAt − 24h ≤ now < startsAt − 18h` and `reminders.daySentAt` is unset. Each window is one sweep-friendly band just after its mark, not everything from the mark to the event.
- The windows are narrow on purpose: a pod that was down for the whole band, or an event created after the band passed, skips that reminder rather than sending a "one week" note three days out or a "tomorrow" note at lunchtime. An event created less than seven days ahead gets only the day reminder; one created less than a day ahead gets none — its confirmation email is the reminder.
- **At-most-once:** the sweep records `reminders.<kind>SentAt = now` on the event *before* sending, in its own commit under the write mutex, then emails each going attendee. A send failure is logged and not retried; a duplicate reminder is the worse failure.
- Each reminder email goes to the attendee's `PrivateProfile.email` and includes the when/where block, the member's follow-up answer if any ("You said you're coming to work on SquadQuest"), the canonical URL, and a "Can't make it? Update your RSVP" link. The `.ics` is not re-attached — the confirmation already delivered it.
- Members who RSVP after a reminder was sent don't receive that reminder. They were just on the page.
- There is no opt-out other than withdrawing the RSVP; reminders are transactional mail about something the member asked for.

## Changing and cancelling after people RSVP'd

- A PATCH that changes `startsAt`, `endsAt`, `venueName`, `venueAddress`, or `onlineUrl` on a `scheduled` event with at least one RSVP sends every going attendee an **"Event updated"** email that names what changed (old → new) and attaches the refreshed `.ics`. Title or description edits bump nothing but `icsSequence` (title) and send no mail.
- `cancel` sends every going attendee a **"Cancelled"** email carrying the optional `cancellationNote` and the `.ics` with `STATUS:CANCELLED`. RSVP records are kept — they are the historical record of who had planned to come.
- Both sends are fire-and-forget and the mutation succeeds regardless of delivery.

## Duplicating

Monthly events are the whole point and there is **no recurrence engine**. Instead the event form accepts `?from=<slug>`: it opens prefilled with every field of the source event — including its series and agenda — except `slug`, `status` (always `scheduled`), RSVPs, and reminder bookkeeping, with `startsAt`/`endsAt` (and each agenda item) shifted forward one month in `America/New_York`. "One month" keeps the day-of-month and wall-clock time; a day the next month lacks (Jan 31 → Feb) clamps to that month's last day. Staff adjust the date and save. One explicit record per occurrence means every event can be edited, cancelled, and RSVP'd independently, and the data repo shows exactly what was announced.

The form is a convenience, not the only door. `POST /api/events` is the same write, so a script or an agent can create next month's hack night with one call; and because the data repo is the store, a record committed directly to `published` (the way blog posts are authored) arrives through hot reload like any other data change. Whichever path creates the record, reminders, RSVPs, and the feed treat it identically.

## Meetup transition

`meetupUrl` is an optional link to the same event on Meetup.com. While it is set, the detail page shows a small "Also listed on Meetup" link *below* the RSVP control — never beside or above it. The site's RSVP is the thing we're asking people to do; the Meetup link exists so nobody who still lives there is stranded. Once a listing has no Meetup counterpart the field is simply empty.

## Legacy URLs

Laddr served `/events`, `/events/*past`, `/events/*upcoming`, `/events/*all`, `/events/<handle>`, and `/events/<handle>/segments/<segHandle>`. The rewrite answers them per [legacy-id-mapping.md](legacy-id-mapping.md#legacy-url-forms-we-accept): the starred list views 301 to `/events/past` or `/events`; the four historical laddr events are backfilled with their slugs preserved, their segments as agenda items, and a "Launchpad" series grouping the three Launchpads, so `/events/launchpad-2023` keeps resolving; segment URLs 301 to the event's schedule anchor.

## Principles

**Inherited** — no `principles.md` exists in this project yet; the project-wide stances that bite here are in [architecture.md](../architecture.md): public-by-design storage and the fire-and-forget notifier contract.

**Local** — the decisive rules for any case the sections above don't enumerate:

- **Philly time, always.** When a time could be shown in the viewer's zone or in `America/New_York`, show Philly time with its abbreviation. The event is in one place; the page should agree with the sign on the door.
- **One record per occurrence.** When a feature tempts a recurrence rule or a template that generates events, reach for "duplicate" instead. A series is a label, never a generator. Every occurrence is an independent, editable, cancellable record with its own RSVPs; the data repo's history shows what was actually announced, not what a rule would have produced.
- **Sessions don't get identity until they need RSVPs.** An agenda item is a line in a schedule. The moment someone needs to RSVP to it, reminder for it, or link to it on its own, it becomes an event in the same series — not a new kind of record.
- **Our RSVP is the call to action.** Any link to an external listing (Meetup, Eventbrite, tickets) is secondary in position and weight. The site is displacing Meetup, not pointing at it.
- **RSVPs are public.** The attendee list is the feature, and the data repo is public anyway. Never add a privacy knob the storage can't honor.
- **The write never waits on the mail.** RSVP, cancel, and update succeed whether or not email delivers; reminders are at-most-once. A missed email is recoverable from the site; a duplicate or a failed RSVP is not.
