---
status: done
depends: [events-series-agenda]
specs:
  - specs/behaviors/events.md
  - specs/behaviors/legacy-id-mapping.md
  - specs/data-model.md
issues: [194]
pr: 213
---

# Plan: Backfill the four laddr events

## Scope

Laddr held exactly four events (`launchpad-2018`, `launchpad_2019`,
`datahack2020`, `launchpad-2023`), each with a handful of schedule segments.
Carry them into the `events` sheet so `/events/past` has history and the old
URLs keep resolving.

**In:** four hand-authored event records plus one `event-series` record
("Launchpad", grouping the three Launchpads) on the data repo's `published`
branch (via PR, per that repo's conventions), with `legacyId`, original
handles as slugs, `status: scheduled`, and each laddr segment carried as an
`agenda` item (title, times, venue, summary + description). Legacy
`/thumbnail/<id>/…` images referenced in descriptions are captured as
attachments and rewritten, per
[legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md#legacy-resources-captured-at-import-time-not-proxied-at-runtime).

**Out:** per-session events
([deferred.md](../specs/deferred.md#per-session-rsvps-on-multi-day-events));
any Meetup check-in history (dropped).

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
   event (epoch → ISO UTC, `Status` → `scheduled`, each segment → an
   `agenda` item with `Summary` and `Description` joined by a blank line;
   the one segment whose `EndTime` precedes its `StartTime` gets `endsAt`
   dropped) and emits the TOML via the gitsheets API against a working clone
   of the data repo. The three Launchpads get `seriesId` of the "Launchpad"
   series; DataHack stands alone.
3. Open the data-repo PR; merge to `published`; the hot-reload webhook
   picks it up.
4. Add the `/events/<handle>/segments/<seg>` → `/events/<handle>#schedule`
   rewrite to `plugins/legacy-redirect.ts`.

## Validation

- [ ] `/events/launchpad-2023`, `/events/launchpad_2019`,
  `/events/datahack2020`, `/events/launchpad-2018` render on production
  with the Schedule sidebar listing every laddr segment under its day with
  time range and venue.
- [x] `/events/series/launchpad` lists the three Launchpads under Past.
- [x] No description references `codeforphilly.org/thumbnail/…`.
- [x] `/events/launchpad-2023/segments/friday_night_kickoff-2023` 301s to
  the event's schedule anchor.
- [x] `/events/past` shows the four events in reverse start order.

## Risks / unknowns

- **Agenda range rule.** Laddr's `launchpad-2018` had segments with null
  `EndTime` and one with end before start; the agenda validator requires
  each item's start inside the event range, which these satisfy, but check
  the event `endsAt` covers the last segment before importing.

## Notes

- **The production check stays open on purpose.** Everything above was
  verified by booting the API locally on the branch the script produced;
  the first criterion closes when codeforphilly-data #12 is merged into
  `published` *after* the app release that opens the `events` and
  `event-series` sheets is on production (the running v0.6.x reads
  neither, so merging earlier is harmless but proves nothing).
- **Two events needed their end stretched** to cover a segment: laddr's
  `launchpad-2018` listed a `work_day` after its own EndTime, and
  `datahack2020`'s last session ran past its EndTime by half an hour. The
  script logs each stretch as a warning rather than dropping the item.
- **laddr's segment `workshops` on 2018** had an end before its start; it
  is carried with `endsAt` dropped, so it renders as a start time only.
- **laddr text was CRLF and used `###Heading` with no space**, which its
  own renderer accepted and GFM shows literally. The script normalizes
  both; the sponsor logos in 2019's description are full-width images in
  the source and render that way.
- **Twenty attachments** (`events/<slug>/media-<id>.<ext>`) came from
  `/media/<id>/original` on the legacy host; the `/thumbnail/…` and
  absolute `codeforphilly.org/…` forms are both rewritten to
  `/api/attachments/events/<slug>/…`.
- **The branch is created with raw `git update-ref`** from `--parent`
  (default `refs/remotes/origin/published`, `refs/heads/published` on a
  bare clone), exactly like the importer, because gitsheets 2.7's
  `transact({ branch })` only advances an existing ref. Existing records
  are read back through a no-op transaction parented on the branch tip so
  reruns update in place; an unchanged rerun returns `commitHash: null`.
- **Step 4 was already done by `events-core`**; the redirect test there
  covers it.

## Follow-ups

- Tracked as: merge codeforphilly-data #12 into `published` once the
  release containing #207/#209/#211 is live, then tick the production
  criterion above.
