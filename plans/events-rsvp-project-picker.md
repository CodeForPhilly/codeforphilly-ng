---
status: done
depends: [events-core]
specs:
  - specs/screens/event-detail.md
  - specs/behaviors/storage.md
  - specs/api/projects.md
issues: [194]
pr: 223
---

# Plan: find-as-you-type project picker in the RSVP follow-up

## Scope

The follow-up's "I'm coming to work on …" choice rendered a `<select>` of
every non-deleted project — 272 entries, cut off, unsorted by anything a
member cares about. Replace it with a combobox that never lists the
catalog: opened empty it offers the projects other attendees of this event
have already named (most recent answer first, at most eight), and typing
searches projects server-side with the last word as a prefix.

**In:** the `ProjectPicker` component and its use in the event detail
follow-up; last-word prefix matching in the full-text search query (which
also improves the header search); the data requirement change on the
event detail screen. **Out:** the header search box's own UI; project
pickers elsewhere (the help-wanted role modal lists the viewer's own
projects, a different and short list).

## Implements

- [screens/event-detail.md](../specs/screens/event-detail.md) — the
  follow-up's picker rules and the `GET /api/projects?q=` data requirement.
- [behaviors/storage.md](../specs/behaviors/storage.md#full-text-search) —
  last-word prefix matching.
- [api/projects.md](../specs/api/projects.md) — the `q` parameter's
  find-as-you-type note.

## Approach

1. **Search.** `sanitizeFtsQuery` quotes each word; the last word becomes
   a phrase prefix (`"hack"*`). People and help-wanted searches share the
   sanitizer, so they gain the same behavior; the spec says so.
2. **Component.** `apps/web/src/components/ProjectPicker.tsx`, modelled on
   `SeriesPicker` (same combobox roles and keyboard handling), but async:
   a debounced `GET /api/projects?q=&perPage=8` while text is present, and
   a `suggestions` prop for the empty state. Choosing calls `onPick(slug)`.
3. **Screen.** The follow-up derives suggestions from the already-loaded
   RSVP list: RSVPs with a project, newest `updatedAt` first, de-duplicated
   by slug, capped at eight, excluding the viewer's own. The old
   `perPage=100` projects query goes away.
4. **Tests.** Web: opened empty shows suggestions or the hint; typing
   issues the search and lists results; Enter picks and saves. API: the
   FTS prefix behavior.

## Validation

- [x] A member who named a project on one event sees it first, under
  "Your recent projects", when opening the picker on another event
  (`viewerRecentProjects` on the event detail); not on the same event,
  and never when anonymous.
- [x] Opening the picker on an event where nobody has named a project
  shows only "Type a project name"; on one where attendees have, it lists
  their projects newest-first and nothing else.
- [x] Typing `hack` lists projects whose title or text has a word starting
  with "hack", at most eight, in relevance order.
- [x] Choosing saves the RSVP with that project and the follow-up shows
  "I'm coming to work on <title>" with "Change".
- [x] The catalog is never listed unfiltered.
- [x] `npm run type-check && npm run lint && npm test` clean; checked in
  the browser against the devbox test instance.

## Risks / unknowns

- **Prefix on the header search.** Broader matches on the last word
  could reorder results people are used to; relevance ranking still leads
  with full-word hits. Accepted — it is what a search box being typed into
  should do.

## Notes

- Shipped in #223. Two search fixes came out of it: `ProjectService.list`
  used the full-text index only as a filter and then re-sorted by
  `-updatedAt`, so relevance never reached callers; and bm25 ranked a
  word in a project's overview level with the same word in its title.
  Now a search with no explicit sort keeps relevance order, and bm25
  weights title 10 / summary 3 / body 1 (people and help-wanted likewise).
- The empty picker shows nothing but the input's placeholder when there
  are no suggestions; a popover repeating the hint looked like a bug.
- First cut suggested only what other attendees of this event had named.
  Chris's review on devbox: his own project from the previous event
  should come up first. The event detail now carries
  `viewerRecentProjects` (the caller's named projects on other events,
  newest first) and the picker shows it as the first group.
- Kept the hand-rolled combobox (same shape as `SeriesPicker`) rather than
  adopting shadcn's Popover + Command; decided with Chris for launch.

## Follow-ups

- **Deferred:** move `ProjectPicker` and `SeriesPicker` onto shadcn's
  Combobox (`cmdk`) together when a third picker appears; two hand-rolled
  comboboxes is the ceiling.
