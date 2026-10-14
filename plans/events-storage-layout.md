---
status: done
depends: [events-series-agenda]
specs:
  - specs/data-model.md
  - specs/behaviors/storage.md
  - specs/behaviors/events.md
  - specs/behaviors/legacy-id-mapping.md
issues: [194]
pr: 216
---

# Plan: year-partitioned, content-oriented event records

## Scope

Change how event records sit in the data repo before any exist in
production: events partitioned by year and stored as markdown-bodied
records, series stored the same way, RSVPs partitioned under the event's
year. Plus the model clarification that a multi-day program is a series of
per-day events, which touches the legacy redirects.

**In:** the three sheet configs on the data repo's `empty`, `fixture` and
`legacy-import` branches (path templates + `[gitsheet.format]`), mirrored
into `apps/api/gitsheets/`; the RSVP write path injecting `year`; the
`/events/<handle>` → `/events/series/<handle>` legacy redirect; tests and
the dev seed. No schema or contract change is expected — `description`
stays a string field; the format block only moves it to the file body.

**Out:** `published` — the other session adopts there in lockstep with the
release (zero event records exist, so the new templates apply cleanly);
the backfill itself ([`events-legacy-backfill`](events-legacy-backfill.md),
which now depends on this plan).

## Implements

- [data-model.md](../specs/data-model.md#event) — Event / EventSeries /
  EventRsvp sheet, path template and format lines; the laddr naming-map
  rows.
- [behaviors/storage.md](../specs/behaviors/storage.md#sheet-layout) —
  the three rows.
- [behaviors/events.md](../specs/behaviors/events.md#series) — the Series
  and Agenda semantics (program instance = series of per-day events) and
  the Legacy URLs paragraph; the "One venue, one span, one event"
  principle.
- [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md#legacy-url-forms-we-accept) —
  `/events/<handle>` and segment rows now point at the series page.

## Approach

1. **Configs.** `events.toml`: `path = '${{ startsAt: YYYY }}/${{ slug }}'`
   (gitsheets' native date bucket, which also lets range filters prune
   partitions)
   plus `[gitsheet.format] type = 'markdown', body = 'description'`.
   `event-series.toml`: same format block, path unchanged.
   `event-rsvps.toml`: `path = '${{ year }}/${{ eventSlug }}/${{ personSlug }}'`.
   One commit per data branch (empty, fixture, legacy-import), PRs, then
   mirror `empty`'s `.gitsheets/` into `apps/api/gitsheets/`. Contract
   documents unchanged; `gitsheets contracts verify` before each push.
2. **Write path.** `withRsvpPath` adds `year` (the event's partition year —
   the UTC year of `startsAt`, identical to what the native bucket renders
   because every stored timestamp is a `Z` string) next to `eventSlug` and
   `personSlug`; the sheet
   guard test lists it under `WRITE_INJECTED_PATH_FIELDS['event-rsvps']`.
   Event writes need nothing: gitsheets renders the year from `startsAt`
   and splits `description` into the body on write, joins on read.
3. **Rename moves.** A slug rename already rewrites each RSVP file; a
   `startsAt` change that crosses a year boundary must now move the event
   file and every RSVP file too — handle both in `EventWriteService.update`
   by deleting the old paths before the upsert whenever the partition year
   or slug changes.
4. **Redirects.** `plugins/legacy-redirect.ts`: `/events/<handle>` whose
   handle is a live series slug (and not a live event slug) 301s to
   `/events/series/<handle>`; segment URLs 301 to the series page.
5. **Tests + seed.** Rename/boundary move cases; the redirect rows; the
   events tests keep passing against markdown records (assert a created
   event's file lands at `events/<year>/<slug>.md` via `git ls-tree`).

## Validation

- [x] A created event lands at `events/<YYYY>/<slug>.md` with its
  description as the markdown body; reading it back through the API is
  byte-for-byte the description that was sent.
- [x] An RSVP lands at `event-rsvps/<YYYY>/<eventSlug>/<personSlug>.toml`.
- [x] Moving an event's `startsAt` across a year boundary moves its file
  and its RSVP files in the same commit; renaming its slug still does.
- [x] A series' description is the body of `event-series/<slug>.md`.
- [x] `/events/launchpad-2023` 301s to `/events/series/launchpad-2023` when
  that series exists and no event has that slug.
- [x] `check:sheet-configs` matches `empty`; `check-contracts` unchanged.
- [x] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Markdown body + agenda descriptions.** Only the event's own
  `description` becomes the body; agenda item descriptions stay as
  frontmatter strings. Confirm gitsheets serializes an array of tables
  with multi-line strings in frontmatter cleanly (blog posts have no
  nested arrays).
- **Year partition is UTC.** `${{ startsAt: YYYY }}` is the UTC year, so a
  New Year's Eve evening in Philadelphia files under the next year. It is
  a storage partition, invisible in URLs; accepted for determinism.

## Notes

- Shipped in #216 alongside codeforphilly-data #17 (empty), #18 (fixture),
  #19 (legacy-import). No records existed in these sheets on any branch,
  so the templates applied without a migration.
- **gitsheets refuses a body-less markdown upsert** unless told the
  omission is deliberate (`allowMissingBody`). Events and series without
  a description are normal and our upserts always carry the full record,
  so both write services opt in (`MARKDOWN_UPSERT`). A body-less file
  reads back as `''`, not `null`; the serializers fold it to `null` so the
  API contract is unchanged.
- **Body normalization.** gitsheets trims the body's trailing newline on
  write; everything before it round-trips byte-for-byte. The validation
  criterion holds for descriptions as the editor sends them.
- The partition year is computed once (`partitionYear`) and shared with
  the purge cascade; it is the UTC year of `startsAt`, identical to the
  native bucket because every stored timestamp is a `Z` string. A
  Dec 31 → Jan 1 move is covered by a test.
- The spec/plan wording moved from the slice expression to the native
  `${{ startsAt: YYYY }}` bucket in the same PR — a syntax detail inside
  the already-accepted decision, not a behavior change.

## Follow-ups

- **Deferred to plan:** [`events-legacy-backfill`](events-legacy-backfill.md)
  writes the first records into these sheets; it must pass
  `MARKDOWN_UPSERT` (or use the write services) for series and events
  without descriptions.
- **None** for `published`: the release session adopts the configs there
  in lockstep with the release that enables events.
