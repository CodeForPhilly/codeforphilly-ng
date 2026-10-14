---
status: done
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
pr: 211
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

- [x] Creating an event with `seriesSlug` links it; `GET /api/event-series/:slug`
  lists it under `upcoming`, and under `past` once `endsAt` passes.
- [x] An agenda item outside the event's range is rejected with a per-row
  `422`; items come back sorted by `startsAt` regardless of input order.
- [x] `DELETE /api/event-series/:slug` answers `409 has_events` while an
  event references it and `204` after the event is reassigned.
- [x] Event detail shows "Part of <series>" and, for an event with agenda,
  the day-grouped Schedule with venue lines only where the venue changes.
- [x] Duplicating an event keeps its series and shifts each agenda item one
  month, with the rows visible in the editor before save (deferred from
  [`events-core`](events-core.md)).
- [x] `.ics` `DESCRIPTION` carries the schedule text for an agenda event and
  nothing extra for a plain one.
- [x] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Agenda editor UX.** A repeatable row editor is the most form-heavy
  piece in the app. Keep it behind the disclosure and ship the minimum
  (add, remove, edit rows; sort on save) — drag reordering is unnecessary
  because order is derived from time.
- **Series combobox create-inline.** Creating the series on save means two
  writes; if the event save then fails, the series exists without events.
  Acceptable (staff can delete it) and simpler than a transactional pair.

## Notes

- **Agenda validation and ICS text already shipped in `events-core`**;
  this plan added the series sheet, endpoints, and all of the UI. The
  ICS schedule block was verified again here with venue overrides.
- **No `Command` component exists in the repo**, so the series picker is
  a hand-rolled accessible combobox (input + listbox, arrow keys, Enter,
  Escape) rather than a shadcn add. Typing an existing series' title in
  any case reuses it instead of creating a duplicate.
- **Visibility rule as built:** a series is hidden from non-staff when it
  has no event they may see — that covers "all drafts" and "no events
  yet" alike, so a freshly created empty series is a staff-only page until
  its first published event.
- **`event_series` is a `LegacyHandleEntity`** (no underscores, 100 chars)
  purely so the slug-redirect plugin's pattern list can carry it; the
  series pattern is registered ahead of the event pattern so
  `/events/series/<old>` resolves as a series rename rather than an event
  named `series`.
- **The venue line's "previous" venue** starts from the event venue each
  day and treats an item without an override as being at the event venue;
  the end-time field on a schedule row is a time on the row's start date and
  an end at or before the start runs past midnight. Both written back to
  the specs in this PR.
- **The fixture series (step 2) was not added to the data repo's
  `fixture` branch**; the dev seed used for the browser check was a
  throwaway script. Tracked below with the fixture events from
  `events-core`.
- **Delete tooltip text is not asserted in web tests**: jsdom can't open
  Radix tooltips (no `ResizeObserver`), so the test checks the disabled
  state and the focusable wrapper.
- **Browser check** on a seeded dev repo: an event with four agenda items
  across three days (venue pin only on the two items away from City Hall),
  the series page listing it under Upcoming, and the duplicate form with
  the series preselected and all four rows shifted a month.

## Follow-ups

- Tracked as: add a fixture series plus one upcoming and one past event
  (with RSVPs) to codeforphilly-data `fixture`, together with the fixture
  events `events-core` left open.
