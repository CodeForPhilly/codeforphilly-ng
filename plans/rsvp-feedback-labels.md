---
status: done
pr: 237
depends: [events-core]
specs:
  - specs/behaviors/events.md
  - specs/screens/event-detail.md
issues: []
---

# Plan: Attendee groups and the cancel control, from launch feedback

## Scope

Early feedback in #website-relaunch on the November hack night page:

- A member listed under **Not sure yet** read it as doubt about attending
  (it meant "hasn't said what they're coming to do"); a second organizer
  found it unclear too.
- A member asked for a way to say they're not going: the existing quiet
  "Can't make it?" link next to "You're going ✓" went unseen.
- A member asked for "Maybe"; decided against it (an unsure member says
  yes, adds it to their calendar, and cancels if plans change).

**In:** unanswered attendees listed first, unlabelled, directly under
"Going (N)"; "Looking for a project" renamed "No project yet" to mirror the
choice "I don't have a project yet"; "Can't make it?" becomes an outline
"Cancel RSVP" button with a "Cancel your RSVP?" dialog; the no-maybe
rationale extended in the spec.

**Out:** "Maybe"; the email copy ("Can't make it? Update your RSVP…"),
which already points at the page.

## Implements

- [behaviors/events.md](../specs/behaviors/events.md#rsvp) — RSVP and the
  follow-up groups.
- [screens/event-detail.md](../specs/screens/event-detail.md) — RSVP block,
  attendee list, Withdraw action.

## Approach

1. `groupAttendees` puts the unanswered first with `label: null` (the
   renderer already skips the heading for an unlabelled group); the
   all-unanswered special case falls out of that.
2. Swap the text button for a shadcn outline `Button`; reword the dialog.

## Validation

- [x] `npm run type-check && npm run lint && npm test` clean.
- [x] On an event with mixed answers (component test; devbox has one RSVP), the unanswered avatars sit directly
  under "Going (N)" and the labelled groups follow.
- [x] Signed in and going, "Cancel RSVP" shows beside "You're going ✓" and
  cancels after the dialog.

## Risks / unknowns

- None.

## Notes

- Feedback from Kat Jost and Travis Southard in #website-relaunch after
  the events launch (2026-10-14). Chris decided: no "Maybe" for now, and
  the unanswered shouldn't trail the list where they'd look like members
  of the last labelled group.
- Checked signed in on the devbox build: "Cancel RSVP" beside "You're
  going ✓"; the dialog opens with "Keep my RSVP" focused.

## Follow-ups

- **None.**
