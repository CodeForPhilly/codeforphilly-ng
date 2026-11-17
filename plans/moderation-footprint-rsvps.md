---
status: done
depends: [admin-members-moderation, events-core]
specs:
  - specs/api/moderation.md
  - specs/screens/admin-members.md
  - specs/behaviors/person-lifecycle.md
  - specs/behaviors/spam-exclusion.md
issues: [266]
pr: 267
---

# Plan: Event RSVPs in the moderation footprint

## Scope

Issue [#266](https://github.com/CodeForPhilly/codeforphilly-ng/issues/266):
staff reviewing new accounts on `/admin/members` see a member's memberships,
updates, buzz, blog posts, help-wanted interest and tags, but not their event
RSVPs. An RSVP to a hack night can be the only sign that an otherwise empty
new account is a real volunteer, and a purge deletes the RSVP with the
account, so staff should see it before they vote.

**In:**

- `rsvps` in the detail footprint of `GET /api/admin/members/:slug`: per RSVP,
  the event's `slug`, `title` and `startsAt`, and the RSVP's `createdAt`;
  newest RSVP first; past and cancelled events included; agent callers with
  `moderation:read` see the same list.
- `rsvps` in the roster row's `footprint` counts (`GET /api/admin/members`).
- `/admin/members`: an `{n} RSVP(s)` count on the row (only when non-zero, like
  updates and buzz) and an **Event RSVPs** list in the detail panel.
- Spec lines that were missing for existing behavior: the purge cascade and
  the offline prune both already delete the person's `event-rsvps`, but
  `person-lifecycle.md` and `spam-exclusion.md` did not say so.

**Out:**

- Spam scoring: RSVPs do not count toward `has-footprint` or `attention`, the
  roster's default review filter is unchanged, and the agent vote and purge
  rules are unchanged. The spec now says so explicitly for `has-footprint`.
- Purge behavior (unchanged; it already deletes RSVPs).
- The offline batch cleanup (#265).
- Any data-repo sheet contract: this is a response-shape change only.

## Implements

- [api/moderation.md](../specs/api/moderation.md) — `footprint.rsvps` on the
  roster row and the detail; the `has-footprint` definition.
- [screens/admin-members.md](../specs/screens/admin-members.md) — the row's
  count and the detail's Event RSVPs list.
- [behaviors/person-lifecycle.md](../specs/behaviors/person-lifecycle.md) and
  [behaviors/spam-exclusion.md](../specs/behaviors/spam-exclusion.md) — the
  purge and prune cascades name `event-rsvps` (documenting what the code does).

## Approach

1. Specs first (above).
2. `services/moderation.ts`: `FootprintCounts.rsvps` from the existing
   `rsvpsByPerson` index (`Map<personSlug, Set<rsvpId>>`, already documented in
   `data-model.md#eventrsvp`); `MemberFootprint.rsvps` resolves each RSVP's
   event through `eventBySlug` and drops an RSVP whose event is not in memory,
   the way the other lists drop a missing project. No new index; no route
   change (the route already spreads the footprint).
3. Web: the `MemberRow` / `MemberFootprint` types in `lib/api.ts`; the row's
   count and the detail's section in `AdminMembers.tsx`, using the page's
   existing `section()` helper and `formatAbsoluteDate`.
4. Tests: API detail and roster (`moderation-rsvps.test.ts`), the signal rule
   (`moderation-signals.test.ts`), and the first component test for the page
   (`apps/web/tests/AdminMembers.test.tsx`).

## Validation

- [x] `npm run type-check && npm run lint && npm test` clean.
- [x] Detail: a member with RSVPs lists them newest first, a past event and a
  cancelled event included; each item is exactly `{ event: { slug, title,
  startsAt }, createdAt }` (no `plan`, `projectId` or id).
- [x] Detail: a member with no RSVPs gets `[]`; another member's RSVP to the
  same event never shows.
- [x] An agent with `moderation:read` sees the same `rsvps` as staff, and no
  email anywhere in the response.
- [x] Roster: `footprint.rsvps` counts each member's RSVPs, for staff and agent
  callers; RSVPs alone do not set `has-footprint`.
- [x] A new RSVP (`PUT /api/events/:slug/rsvp`) shows on the roster count and
  in the detail at once.
- [x] Web: the row shows `3 RSVPs` / `1 RSVP` and nothing for zero; the detail
  lists Event RSVPs linking to `/events/<slug>` with the event date and when
  they RSVP'd; no section when there are none.
- [x] No sheet contract changed: `packages/shared` and `contracts/` untouched;
  `npm run -w packages/shared check-contracts` clean.

## Risks / unknowns

- None of note. The per-row count is an index lookup, so the roster's cost is
  unchanged; the detail walks only the member's own RSVPs.

## Notes

- The purge cascade already deletes RSVPs:
  `apps/api/src/services/person-purge.ts` → `purgePersonRecords` (step "3b",
  through `rsvpsByPerson`), covered by `apps/api/tests/events.test.ts` →
  "person purge removes the purged person's RSVPs". The offline prune
  (`apps/api/scripts/prune-spam.ts`) deletes them too (`eventRsvpsDeleted`).
- RSVPs reference the person by slug (`event-rsvps/${year}/${eventSlug}/${personSlug}`),
  so the lookup is by slug, like help-wanted interest and memberships.
- Dates in the detail are shown in the viewer's local zone, like the other
  footprint dates on the page, not the event's `America/New_York` wall clock.
- Not browser-tested on the devbox; the component test covers the row and the
  detail panel.

## Follow-ups

- Tracked as: issue #266's question of whether an RSVP should count as a "not
  spam" signal in the roster's default review view (e.g. toward
  `has-footprint`, or a positive signal of its own). Left out on purpose; a
  spec decision for the operators.
- Tracked as: issue #265 (offline batch cleanup) should count an RSVP as a
  contribution, or at least never remove an account with one automatically.
  Belongs to that issue's plan.
