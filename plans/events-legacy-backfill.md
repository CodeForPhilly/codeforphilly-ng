---
status: planned
depends: [events-storage-layout]
specs:
  - specs/behaviors/events.md
  - specs/behaviors/legacy-id-mapping.md
  - specs/data-model.md
issues: [194]
---

# Plan: Backfill the four laddr events

## Scope

Laddr held exactly four "events" (`launchpad-2018`, `launchpad_2019`,
`datahack2020`, `launchpad-2023`), each a multi-week program with a handful
of schedule segments. Under the data model each is a **series** whose days
are events: carry them into the `event-series` and `events` sheets so
`/events/past` has history and the old URLs keep resolving.

**In:** one `event-series` record per laddr event (slug = laddr handle,
title and description from the program), one `events` record per calendar
day of segments (slug `<YYYY-MM-DD>-<series slug>`, venue from the day's
first segment, span from the day's first start to its last end, the day's
segments as `agenda` items), legacy `/thumbnail/<id>/…` images captured as
attachments on the event whose text references them and rewritten per
[legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md#legacy-resources-captured-at-import-time-not-proxied-at-runtime).
Committed through gitsheets on a branch of the data repo for a PR into
`published`.

**Out:** any Meetup check-in history (dropped); RSVPs for historical
events (there were none on the site).

## Implements

- [behaviors/events.md](../specs/behaviors/events.md#legacy-urls).
- [legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md#legacy-url-forms-we-accept) —
  `/events/<handle>` and `/events/<handle>/segments/<seg>` → the series page
  (the redirect itself ships in `events-storage-layout`).
- [data-model.md](../specs/data-model.md#event) — the laddr naming-map rows.

## Approach

1. Source data is the laddr JSON (`/events/*all?format=json` and
   `/events/<handle>/segments?format=json`), captured in the research
   scratchpad during spec work; re-fetch from
   `codeforphilly.live.k8s.phl.io` if needed while it's up.
2. `apps/api/scripts/backfill-laddr-events.ts` (already on the
   superseded #213 branch, to be reworked): per laddr event, write the
   series (description = the program's markdown, media rewritten, CRLF and
   space-less headings normalized); group its segments by Philadelphia
   calendar day; per day write an event titled after the day's first
   segment (or "<series title> — <weekday>" when the first segment is
   generic), `venueName`/`venueAddress` from the first segment that has one,
   `startsAt` = first start, `endsAt` = last end (or last start + 1h), the
   day's segments as agenda items (a segment whose `EndTime` precedes its
   `StartTime` keeps `startsAt` only). Images referenced by a segment go on
   that day's event; images referenced by the program description go on
   the series (series are content records too) — if series attachments are
   not supported by the config, fall back to the first day's event and
   rewrite accordingly.
3. Re-runnable: series match by slug, events by `(seriesId, date)`;
   an unchanged run is a no-op commit. Branch created from a parent ref
   with raw `git update-ref`, then `transact({ parent, branch })`.
4. Regenerate codeforphilly-data #12 (close the old branch) and merge it
   into `published` after the release that reads these sheets is live.

## Validation

- [ ] `/events/series/launchpad-2023`, `/events/series/launchpad_2019`,
  `/events/series/datahack2020`, `/events/series/launchpad-2018` render on
  production, each listing its days under Past with venue and date.
- [ ] Each day's event renders its Schedule with every laddr segment of
  that day, time range and venue.
- [ ] `/events/launchpad-2023` and
  `/events/launchpad-2023/segments/friday_night_kickoff-2023` 301 to the
  series page.
- [ ] No description references `codeforphilly.org/thumbnail/…`.
- [ ] `/events/past` shows the days in reverse start order.

## Risks / unknowns

- **Day boundaries.** Segments are grouped by Philadelphia day; a segment
  that crosses midnight stays with the day it starts. The 2023 "Weekly
  Hack Nights 4/4 – 5/9" was a single laddr segment on one evening and
  becomes one event on that date with its description listing the other
  dates.
- **Naming the day.** The first segment's title is the event title; for
  2018's work day that is "Work Day", for 2023's "Friday Night Kickoff" —
  check the four programs by eye before merging #12.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
