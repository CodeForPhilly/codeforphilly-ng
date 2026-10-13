---
status: planned
depends: [events-core]
specs:
  - specs/behaviors/events.md
  - specs/behaviors/legacy-id-mapping.md
  - specs/data-model.md
issues: [194]
---

# Plan: Backfill the four laddr events

## Scope

Laddr held exactly four events (`launchpad-2018`, `launchpad_2019`,
`datahack2020`, `launchpad-2023`), each with a handful of schedule segments.
Carry them into the `events` sheet so `/events/past` has history and the old
URLs keep resolving.

**In:** four hand-authored records on the data repo's `published` branch
(via PR, per that repo's conventions), with `legacyId`, original handles as
slugs, `status: cancelled`-free past events, and each event's segments
flattened into a "Schedule" section of its markdown description. Legacy
`/thumbnail/<id>/…` images referenced in descriptions are captured as
attachments and rewritten, per
[legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md#legacy-resources-captured-at-import-time-not-proxied-at-runtime).

**Out:** reviving segments as records
([deferred.md](../specs/deferred.md#event-programs-with-sessions)); any
Meetup check-in history (dropped).

## Implements

- [behaviors/events.md](../specs/behaviors/events.md#legacy-urls).
- [legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md#legacy-url-forms-we-accept) —
  `/events/<handle>` and `/events/<handle>/segments/<seg>` rows.
- [data-model.md](../specs/data-model.md#event) — `legacyId` on Event and
  the naming-map rows.

## Approach

1. Source data is the laddr JSON (`/events/*all?format=json` and
   `/events/<handle>/segments?format=json`), captured in the research
   scratchpad during spec work; re-fetch from
   `codeforphilly.live.k8s.phl.io` if needed while it's up.
2. Write a one-off script under `apps/api/scripts/` that translates each
   event (epoch → ISO UTC, `Status` → `scheduled`, segments → a day-grouped
   markdown "Schedule" section with venue and time range) and emits the TOML
   via the gitsheets API against a working clone of the data repo.
3. Open the data-repo PR; merge to `published`; the hot-reload webhook
   picks it up.
4. Add the `/events/<handle>/segments/<seg>` → `/events/<handle>` rewrite
   to `plugins/legacy-redirect.ts`.

## Validation

- [ ] `/events/launchpad-2023`, `/events/launchpad_2019`,
  `/events/datahack2020`, `/events/launchpad-2018` render on production.
- [ ] Each description's Schedule section lists every laddr segment with
  its date, time range, and venue.
- [ ] No description references `codeforphilly.org/thumbnail/…`.
- [ ] `/events/launchpad-2023/segments/friday_night_kickoff-2023` 301s to
  the event.
- [ ] `/events/past` shows the four events in reverse start order.

## Risks / unknowns

- **Description fidelity.** Flattening segments into markdown loses the
  per-session pages; the deferred programs design would split them back
  out. Keep the segment handles in the Schedule headings so that split is
  mechanical later.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
