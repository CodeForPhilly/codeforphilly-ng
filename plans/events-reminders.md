---
status: in-progress
depends: [events-core]
specs:
  - specs/behaviors/events.md
  - specs/data-model.md
issues: [194]
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

- [ ] A scheduled event 6 days out with three RSVPs gets exactly three
  `week` reminder sends on the first sweep and none on the next.
- [ ] An event created 3 days before start gets only the `day` reminder.
- [ ] An event created 12 hours before start gets no reminders.
- [ ] Cancelled and draft events never get reminders.
- [ ] The bookkeeping commit lands even when the notifier throws on every
  send (at-most-once holds).
- [ ] Sweep runs every 5 minutes after boot and stops on close.
- [ ] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Send fan-out time.** A big event (hundreds of RSVPs) means hundreds of
  sequential Postmark calls inside one sweep tick. Fire-and-forget keeps the
  tick itself fast; if Postmark rate-limits, switch to its batch endpoint
  (500 per call) in the transport — a transport-only change.
- **Clock skew after a long sleep.** The in-process timer doesn't fire while
  the pod is down; the closed windows make that a skipped reminder rather
  than a late or duplicated one. Acceptable by spec.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
