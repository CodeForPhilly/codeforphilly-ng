---
status: done
depends: [events-storage-layout]
specs:
  - specs/behaviors/events.md
  - specs/behaviors/legacy-id-mapping.md
  - specs/data-model.md
issues: [194]
pr: 218
---

# Plan: Backfill the four laddr events

## Scope

Laddr held exactly four "events" (`launchpad-2018`, `launchpad_2019`,
`datahack2020`, `launchpad-2023`), each a multi-week program with a handful
of schedule segments. Under the data model each is a **series** whose days
are events: carry them into the `event-series` and `events` sheets so
`/events/past` has history and the old URLs keep resolving.

**In:** one `event-series` record per laddr event (slug = laddr handle in
slug form, title and description from the program), one `events` record per calendar
day of segments (slug `<YYYY-MM-DD>-<a few words of the day's title>`,
venue from the day's first segment, span from the day's first start to its
last end, the day's segments as `agenda` items — except a first segment
that spans the whole day, whose text is the event's description), legacy
`/thumbnail/<id>/…` images captured as attachments on the record whose
text references them and rewritten per
[legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md#legacy-resources-captured-at-import-time-not-proxied-at-runtime).
Also the **Monthly Hack Nights** series seeded from Meetup — the last two
past and every scheduled hack night, each with `meetupUrl`, the Meetup
description's "Agenda" block as agenda items — so the series the site
exists to replace has a reference pattern to design against. Committed
through gitsheets on a branch of the data repo for a PR into `published`.

**Then curated by hand.** The scripts get the records close; the handful
of records are then reviewed one by one on the branch (titles, descriptions,
venues, spans, agendas) with a design eye, so the result is the reference
pattern future events follow, not a mechanical copy of laddr and Meetup.

**Out:** any Meetup check-in history and RSVP lists (dropped — RSVPs for
upcoming hack nights stay on Meetup until the cutover); RSVPs for
historical events (there were none on the site).

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

- [x] `/events/series/launchpad-2023`, `/events/series/launchpad-2019`,
  `/events/series/data-hack-2020`, `/events/series/launchpad-2018` render on
  production, each listing its days under Past with venue and date.
- [x] Each day's event renders its Schedule with every laddr segment of
  that day, time range and venue (one-session days carry the text as the
  description instead, per the curation pass).
- [x] `/events/launchpad-2023` and
  `/events/launchpad-2023/segments/friday_night_kickoff-2023` 301 to the
  series page; `launchpad_2019` and `datahack2020` through the static map.
- [x] No description references `codeforphilly.org/thumbnail/…`.
- [x] `/events/past` shows the days in reverse start order.

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

- Shipped across #218 (laddr script), #219 (slug keywords, whole-day first
  segment, Meetup seed, curation pass), #221 (slug-form series slugs,
  static laddr handle map, renames keep images) and codeforphilly-data #20
  (records only, rebased onto the v0.7.0 `published` adoption; merged
  after production was live, hot-reloaded incrementally on both pods).
  Live on codeforphilly.org 2026-10-14: 5 series, 31 events, 16 images.
- **Scripts get close; people finish.** The two scripts produced the
  records; a hand pass through the app's own staff write routes
  (`curate-events-backfill.ts`) set the reference pattern: signature days
  titled for their program ("Launchpad Kickoff Night", "Launchpad Work
  Day", "Launchpad Demo Night", "Data Hack Presentations"), hack nights
  plain; dead registration links, laddr UI artifacts, a personal phone
  number and a named contact removed; venues named and addressed
  consistently; schedules that lived in descriptions turned into agenda
  items; the 2023 "Weekly Hack Nights" segment split into its five
  Tuesdays; the 2026 hack-night description rewritten as the pattern
  future nights follow.
- The Monthly Hack Nights seed (September–December 2026, `meetupUrl` on
  each) is the series the site replaces Meetup for; RSVPs stay on Meetup
  until the cutover.
- Found and fixed along the way: event/series renames dropped the
  attachment folder (fixed in #221, with link relinking); gitsheets reads
  sheet configs from the transaction's parent tree, so a branch parented
  on the old layout writes the old layout; markdown upserts with a null
  body need `allowMissingBody` (gitsheets#308).
- Judgment calls: 2018 Demo Night set to 6–8:30 pm (laddr's end was two
  days later); 2020 hack nights given a one-line description from the
  program text; the old `events-backfill` branch on the data repo (closed
  #12) was left in place and not reused.

## Follow-ups

- **Issue-worthy, not filed:** laddr showed sponsor logos through 200px
  thumbnails; series pages render the captured originals at full width.
  A markdown image-size convention would fix it in the renderer.
- **None** for the data: re-running the scripts against `published` would
  overwrite the curation; the branch is the record, and `curate-events-
  backfill.ts` is how to replay it if it ever has to be regenerated.
