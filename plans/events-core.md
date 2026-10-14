---
status: in-progress
depends: []
specs:
  - specs/data-model.md
  - specs/behaviors/events.md
  - specs/api/events.md
  - specs/screens/events-index.md
  - specs/screens/event-detail.md
  - specs/screens/event-edit.md
  - specs/screens/home.md
  - specs/behaviors/app-shell.md
  - specs/behaviors/slug-handles.md
  - specs/behaviors/legacy-id-mapping.md
  - specs/api/conventions.md
  - specs/api/people.md
issues: [194]
---

# Plan: Events and RSVPs

## Scope

The site becomes the system of record for Code for Philly's events, displacing
Meetup.com for the monthly hack night: staff create events, members RSVP with
one click, every RSVP gets a confirmation email with an `.ics`, and the events
show up on `/events`, on the home page, and in a subscribable calendar feed.

**In:** `Event` and `EventRsvp` sheets, schemas, indices, and importer-free
boot; the event and RSVP endpoints of [api/events.md](../specs/api/events.md)
including the two `.ics` routes; the one-click RSVP and its three-way
follow-up (`plan` + `projectId`) with the grouped attendee list; RSVP
confirmation, "event updated", and "cancelled" emails with calendar
attachments; `/events`, `/events/past`, `/events/:slug`, `/events/new`,
`/events/:slug/edit` screens; the home-page strip; header, footer, and
breadcrumb entries; `/calendar` and the `/events/*past`-style legacy
redirects; event-rsvp cascade on person purge.

**Out:** series and agendas ([`events-series-agenda`](events-series-agenda.md)
— the `seriesId` and `agenda` fields ship in the schema here as optional and
unused so no migration is needed later); the reminder sweep
([`events-reminders`](events-reminders.md)); the four historical laddr events
([`events-legacy-backfill`](events-legacy-backfill.md)); everything under
"Deferred" in [deferred.md](../specs/deferred.md) — private RSVPs,
recurrence, capacity, cover images, Slack announcements.

## Implements

- [data-model.md](../specs/data-model.md) — `Event`, `EventRsvp`, the
  `event` SlugHistory type, cascade rules.
- [behaviors/events.md](../specs/behaviors/events.md) — everything except
  the Series, Agenda, and Reminders sections.
- [api/events.md](../specs/api/events.md) — the twelve `/api/events` endpoints
  (not the `/api/event-series` group).
- [screens/events-index.md](../specs/screens/events-index.md),
  [screens/event-detail.md](../specs/screens/event-detail.md),
  [screens/event-edit.md](../specs/screens/event-edit.md).
- [screens/home.md](../specs/screens/home.md) — section 1b.
- [behaviors/app-shell.md](../specs/behaviors/app-shell.md) — nav, footer,
  breadcrumbs.
- [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md) — event
  slug rules and the new reserved words.
- [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md) —
  the `/events/*…` and `/calendar` rewrites.
- [api/conventions.md](../specs/api/conventions.md) — the `text/calendar`
  carve-out.
- [api/people.md](../specs/api/people.md) — purge cascade.

## Approach

1. **Shared schemas.** `packages/shared/src/schemas/event.ts` and
   `event-rsvp.ts` (Zod), exported from the index. `reminders` is an optional
   object with two optional ISO strings so pre-existing records validate.
2. **Data repo configs.** Add `.gitsheets/events.toml` (`root = 'events'`,
   `path = '${{ slug }}'`) and `.gitsheets/event-rsvps.toml`
   (`root = 'event-rsvps'`, `path = '${{ eventSlug }}/${{ personSlug }}'`)
   to `codeforphilly-data` on `empty`, `fixture`, and `published`, following
   that repo's `.claude/CLAUDE.md`. Add two fixture events (one upcoming, one
   past) and a couple of RSVPs on `fixture`. The dev `setup-dev-data.ts`
   script learns the two sheets.
3. **Store.** Register both sheets in `store/sheet-indices.ts` and
   `state-apply.ts`; indices `eventIdBySlug`, `eventIdByLegacyId`,
   `eventsByStartsAt`, `rsvpsByEvent`, `rsvpsByPerson`. Hot reload replaces
   them like every other collection.
4. **Services.** `services/event.ts` (reads: list by `when`, detail with
   `viewerRsvp` + permissions, attendee list) and `services/event.write.ts`
   (create, patch with slug-rename + RSVP path move + `icsSequence` bump,
   publish, cancel, delete, `putRsvp`, `deleteRsvp`). `putRsvp` normalizes
   the follow-up: `plan = project` requires a resolvable `projectSlug`; any
   other plan clears `projectId`. The attendee-list serializer emits records
   in `createdAt` order and the client groups by project, then newcomer /
   no-project / unanswered. Reuse the existing slug-history helper.
   Permissions live in `services/permissions.ts`.
5. **iCalendar.** `lib/ics.ts` builds `VCALENDAR` text from an `Event` per
   the property table in the behavior spec; folded lines, escaped text,
   `METHOD:PUBLISH`. Pure function, unit-tested against fixed timestamps.
   Also exports `googleCalendarUrl(event)`.
6. **Email.** Extend `OutboundEmail` with optional
   `attachments: [{ name, contentType, content }]` and map them in
   `PostmarkTransport` (`Attachments[].Content` is base64). Add
   `notifyEventRsvp`, `notifyEventUpdated`, `notifyEventCancelled` to the
   `Notifier` interface, `LoggingNotifier`, and `EmailNotifier`, with
   templates in `notify/templates.ts` (HTML-escaped like the rest). All
   fire-and-forget from the services.
7. **Routes.** `routes/events.ts`: `feed.ics` registered before `/:slug`;
   `.ics` responses set `Content-Type: text/calendar; charset=utf-8` and
   `Content-Disposition`. Standard envelope elsewhere. Add the `calendar`
   and `events/*…` rewrites to `plugins/legacy-redirect.ts`.
8. **Web.** Screens `EventsIndex`, `EventDetail`, `EventEdit` under
   `apps/web/src/screens/`, routes in `App.tsx` (`/calendar` as a
   `<Navigate>`), header/footer/breadcrumb entries, the home strip.
   Time formatting through one helper that always uses `America/New_York`
   via `Intl.DateTimeFormat` with `timeZoneName: 'short'`.
9. **Tests.** API: list windows (`when`), draft visibility, RSVP create /
   update / withdraw / closed, project selection, slug rename moving RSVP
   files, cancel + delete guards, `.ics` content, notifier spies. Web:
   RSVP control states, attendee grouping, form defaults (ends = start +
   2h30), duplicate shift. Browser check of the three screens and the home
   strip.

## Validation

- [ ] `GET /api/events` returns upcoming-by-end-time ascending; `when=past`
  descending; drafts only for staff.
- [ ] `PUT …/rsvp` creates (201) then updates (200) and never duplicates;
  `DELETE` withdraws; both answer `409 rsvp_closed` for draft, cancelled,
  and ended events.
- [ ] The follow-up round-trips: `plan = project` + slug stores both,
  `plan = newcomer` clears `projectId`, `plan = project` without a slug is
  `422`; the detail page groups attendees by project, then "New to Code for
  Philly", "Looking for a project", "Not sure yet".
- [ ] Confirmation email carries a `text/calendar` attachment whose `UID` is
  `<id>@codeforphilly.org` and whose `SEQUENCE` matches the record.
- [ ] Changing `startsAt` on a scheduled event with RSVPs bumps
  `icsSequence` and fires `notifyEventUpdated` once per attendee; changing
  `description` does neither.
- [ ] `cancel` sets `cancelledAt`, keeps RSVPs, emails attendees with
  `STATUS:CANCELLED`; `DELETE` refuses with `has_rsvps` when RSVPs exist.
- [ ] Renaming an event slug moves `event-rsvps/<old>/…` to
  `event-rsvps/<new>/…` in the same commit and writes `SlugHistory`.
- [ ] `GET /api/events/feed.ics` lists scheduled and cancelled events from
  the last 90 days onward and never a draft; validates in a calendar client.
- [ ] `/events`, `/events/past`, `/events/:slug`, `/events/new`,
  `/events/:slug/edit` render per their screen specs in a browser; times
  show `America/New_York` with the zone abbreviation regardless of the
  browser zone.
- [ ] Home page shows the strip with an inline RSVP on the soonest event and
  hides the strip when nothing is upcoming.
- [ ] `/calendar`, `/events/*past`, `/events/*upcoming`, `/events/*all` 301
  to their targets.
- [ ] Person purge removes the person's event-rsvps.
- [ ] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Postmark attachment size and MIME.** `.ics` files are tiny; the risk is
  Postmark rejecting an unexpected `ContentType`. Verify `text/calendar`
  against the API before relying on it; fall back to
  `application/octet-stream` with the `.ics` name if needed.
- **Gitsheets path move on slug rename.** Moving a directory of RSVP records
  is a delete + write per record inside one transaction. Confirm the
  transact API handles the volume (tens of records) without special
  handling; project rename has the same shape today.
- **Browser `webcal://` handling.** Some browsers won't open the scheme;
  the copy-to-clipboard fallback must be the visible second option, not a
  hidden one.
- **DST in the duplicate shift.** "Same wall-clock time one month later"
  must be computed in `America/New_York`, not by adding seconds to the UTC
  instant, or a 6 PM hack night drifts to 5 PM across the November change.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
