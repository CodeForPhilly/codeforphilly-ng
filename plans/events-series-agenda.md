---
status: in-progress
depends: [events-core]
specs:
  - specs/behaviors/events.md
  - specs/api/events.md
  - specs/data-model.md
  - specs/screens/event-detail.md
  - specs/screens/event-edit.md
  - specs/screens/event-series.md
  - specs/behaviors/app-shell.md
  - specs/behaviors/slug-handles.md
issues: [194]
---

# Plan: Event series and agendas

## Scope

The two optional structures that make flat events cover what laddr's
program-with-sessions model did: an `EventSeries` grouping ("Monthly Hack
Nights", "Launchpad") with its own page, and an embedded `agenda` on each
event rendered as the day-grouped Schedule sidebar.

**In:** the `event-series` sheet, `Event.seriesId` and `Event.agenda`, the
five series endpoints, the "Part of" line and Schedule block on event
detail, the series combobox and schedule row editor on the event form, the
`/events/series/:slug` screen, breadcrumb, series carried through duplicate,
plain-text agenda in the `.ics` description, `series` on `EventSummary`.

**Out:** per-session RSVPs
([deferred.md](../specs/deferred.md#per-session-rsvps-on-multi-day-events));
a series filter on `GET /api/events`; listing series on the index.

## Implements

- [behaviors/events.md](../specs/behaviors/events.md#series) — Series and
  Agenda sections; the series clause of Duplicating.
- [api/events.md](../specs/api/events.md) — `seriesSlug`, `agenda`,
  `series`, the `/api/event-series` group.
- [data-model.md](../specs/data-model.md#eventseries-new) — `EventSeries`,
  agenda items, `eventsBySeries`, `event_series` slug history.
- [screens/event-detail.md](../specs/screens/event-detail.md) — "Part of",
  Schedule block placement rules.
- [screens/event-edit.md](../specs/screens/event-edit.md) — Series and
  Schedule fields.
- [screens/event-series.md](../specs/screens/event-series.md) — whole screen.
- [behaviors/app-shell.md](../specs/behaviors/app-shell.md),
  [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md) — the
  series breadcrumb and slug rules.

## Approach

1. **Schema.** `event-series.ts` in shared; `agenda` as an optional array of
   a nested `agendaItem` schema on `event.ts` (default `[]` on read so
   pre-existing records validate). Validation of "within the event's range"
   lives in the write service, not the Zod schema, because it needs two
   fields.
2. **Data repo.** `.gitsheets/event-series.toml` (`root = 'event-series'`,
   `path = '${{ slug }}'`) on the usual three branches; one fixture series
   that the fixture hack night references.
3. **Store.** `eventSeriesIdBySlug`, `eventsBySeries`; hot-reload swaps
   them with the rest.
4. **Services.** `event-series.ts` / `.write.ts`; extend the event write
   service to resolve `seriesSlug`, normalize and sort `agenda`, and refuse
   series delete with `has_events`. The series detail splits events by
   `endsAt > now`.
5. **ICS.** `lib/ics.ts` appends a plain-text "Schedule" block (day,
   range, title) to `DESCRIPTION` when the agenda is non-empty.
6. **Web.** `EventSeries` screen; `ScheduleSidebar` component shared by the
   detail page (and reusable by the series page later); series combobox
   (shadcn `Command`) and a schedule row editor on `EventEdit`; the
   `?series=<slug>` prefill. Duplicate mode (`?from=`) copies the source's
   agenda rows shifted one month into the editor (deferred from
   [`events-core`](events-core.md), which copies the series only).
7. **Tests.** Agenda range validation, sorting on write, series delete
   guard, slug-history on series rename, `.ics` schedule text, duplicate
   shifting every agenda item, detail page Schedule placement at two
   breakpoints.

## Validation

- [ ] Creating an event with `seriesSlug` links it; `GET /api/event-series/:slug`
  lists it under `upcoming`, and under `past` once `endsAt` passes.
- [ ] An agenda item outside the event's range is rejected with a per-row
  `422`; items come back sorted by `startsAt` regardless of input order.
- [ ] `DELETE /api/event-series/:slug` answers `409 has_events` while an
  event references it and `204` after the event is reassigned.
- [ ] Event detail shows "Part of <series>" and, for an event with agenda,
  the day-grouped Schedule with venue lines only where the venue changes.
- [ ] Duplicating an event keeps its series and shifts each agenda item one
  month, with the rows visible in the editor before save (deferred from
  [`events-core`](events-core.md)).
- [ ] `.ics` `DESCRIPTION` carries the schedule text for an agenda event and
  nothing extra for a plain one.
- [ ] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Agenda editor UX.** A repeatable row editor is the most form-heavy
  piece in the app. Keep it behind the disclosure and ship the minimum
  (add, remove, edit rows; sort on save) — drag reordering is unnecessary
  because order is derived from time.
- **Series combobox create-inline.** Creating the series on save means two
  writes; if the event save then fails, the series exists without events.
  Acceptable (staff can delete it) and simpler than a transactional pair.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
