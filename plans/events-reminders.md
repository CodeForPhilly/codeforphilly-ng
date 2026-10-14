---
status: done
depends: [events-core]
specs:
  - specs/behaviors/events.md
  - specs/data-model.md
issues: [194]
pr: 209
---

# Plan: Event reminder emails

## Scope

The one-week and one-day reminder emails to everyone who RSVP'd, driven by an
in-process sweep with at-most-once bookkeeping on the event record.

**In:** the sweep, the due-window logic, the `reminders.weekSentAt` /
`daySentAt` writes, the `notifyEventReminder` notifier method and template,
tests with a fake clock.

**Out:** anything that re-sends or retries; opt-out preferences; Slack
reminders ([deferred.md](../specs/deferred.md#event-announcements-to-slack)).

## Implements

- [behaviors/events.md](../specs/behaviors/events.md#reminders) — the
  Reminders section in full.
- [data-model.md](../specs/data-model.md#event) — the `reminders` table.

## Approach

1. **Sweep.** `services/event-reminders.ts` exposes `sweep(now)`: for each
   `scheduled` event in `eventsByStartsAt` whose `startsAt` is within the
   next 7 days, compute which reminder (if any) is due per the two windows.
   Registered from a small plugin with `setInterval` every 5 minutes inside
   `onReady`, cleared `onClose`, exactly like the revocation sweeper in
   `auth/middleware.ts`.
2. **Mark then send.** For a due reminder: one `transact` under the write
   mutex setting `reminders.<kind>SentAt = now` (commit message
   `chore(events): mark <kind> reminder sent for <slug>`), then iterate the
   event's RSVPs, resolve each attendee's `PrivateProfile.email`, and call
   `notifier.notifyEventReminder` fire-and-forget. Attendees without an
   email are skipped with a log line.
3. **Notifier.** `notifyEventReminder({ kind: 'week' | 'day', email,
   fullName, event summary fields, projectTitle | null })`. Subject
   `Next week: <title>` / `Tomorrow: <title>`; body per the behavior spec.
4. **Tests.** Unit-test the due-window function against a table of
   `(startsAt, now, reminders)` cases including: created inside the final
   day (no reminders), pod down across the whole week window (skips week,
   sends day), already sent (no-op), cancelled (no-op). Service test with a
   stubbed notifier asserts one call per RSVP and that the bookkeeping
   write precedes the sends.

## Validation

- [x] A scheduled event 6 days out with three RSVPs gets exactly three
  `week` reminder sends on the first sweep and none on the next.
- [x] An event created 3 days before start gets only the `day` reminder.
- [x] An event created 12 hours before start gets no reminders.
- [x] Cancelled and draft events never get reminders.
- [x] The bookkeeping commit lands even when the notifier throws on every
  send (at-most-once holds).
- [x] Sweep runs every 5 minutes after boot and stops on close.
- [x] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Send fan-out time.** A big event (hundreds of RSVPs) means hundreds of
  sequential Postmark calls inside one sweep tick. Fire-and-forget keeps the
  tick itself fast; if Postmark rate-limits, switch to its batch endpoint
  (500 per call) in the transport — a transport-only change.
- **Clock skew after a long sleep.** The in-process timer doesn't fire while
  the pod is down; the closed windows make that a skipped reminder rather
  than a late or duplicated one. Acceptable by spec.

## Notes

- **The windows got narrower than first written.** The spec as merged in
  #197 said "due from 7 days out until 1 day out", which would have sent a
  "one week" note to an event created three days ahead — the opposite of
  the sentence after it. #208 fixed the spec before this plan started:
  week = `[start−7d, start−6d)`, day = `[start−24h, start−18h)`. Miss the
  band (pod down, event created late) and that reminder is skipped, never
  sent late.
- **There is no `eventsByStartsAt` index.** The corpus is roughly one event
  a month, so the sweep filters `state.events.values()` directly; the
  approach text above predates that decision in `events-core`.
- **The sweep awaits each send rather than fire-and-forget**, so `sent`
  counts attempts and a throwing notifier is caught per attendee. The
  bookkeeping commit still lands first, which is what at-most-once needs;
  awaiting only keeps the tick's log lines in order.
- **Marking an event with no RSVPs still writes the bookkeeping commit** so
  the event isn't re-evaluated every tick for the rest of the band.
- **The timer is skipped under `NODE_ENV=test`** (tests boot many apps and
  would leak intervals); the test for the timer boots one app under
  `development` and spies on `setInterval` / `clearInterval`.
- **`services/event-notify.ts`** now owns the event-email facts, the
  attendee fan-out, and the follow-up sentence; the RSVP / updated /
  cancelled routes share it with the sweep.
- **Bookkeeping commits are authored `cfp-api <api@codeforphilly.org>`**,
  the same identity the revocation sweeper uses, with the message
  `events: mark <kind> reminder sent for <slug>` rather than the `chore(…)`
  form the approach guessed — commit messages in the data repo follow the
  `<actor>: <what>` shape, not conventional commits.

## Follow-ups

- Tracked as: watch the first real hack night's reminder commits and
  Postmark activity on production; if a 100+ RSVP event ever appears,
  switch the transport to Postmark's batch endpoint per the risk above.
