---
status: done
depends: [purge-created-projects]
specs:
  - specs/behaviors/person-lifecycle.md
  - specs/api/moderation.md
  - specs/screens/admin-members.md
issues: []
---

# Plan: Purge spam-voted accounts automatically after three days

## Scope

Chris (2026-10-15): a spam vote on /admin/members only deactivated the
person; deleting them took a manual pipeline run or a Purge click per
account. He asked for an in-process daily job that purges everyone marked
spam three or more days ago with no not-spam votes, all in one commit.

**In:** `spamPurgeDueAt` / `queuedForSpamPurge` (all human votes `spam`,
newest ≥ 3 days old, still deactivated, `accountLevel = user`); a daily
in-process sweep that purges the queue in one `cfp-api` commit listing the
slugs, re-checking the queue inside the write mutex; the project rule
judged across the batch (a project only queued spammers touched goes);
`purgeAfter` on roster rows and a "Purges {date}" chip on /admin/members.

**Out:** the offline `prune-spam` script in the private repo (its machine
verdicts are a separate path); deleting the votes themselves (kept as the
record).

## Implements

- [behaviors/person-lifecycle.md](../specs/behaviors/person-lifecycle.md#scheduled-spam-purge)
- [api/moderation.md](../specs/api/moderation.md) — `purgeAfter`.
- [screens/admin-members.md](../specs/screens/admin-members.md) — the chip.

## Approach

1. Move the purge cascade into `purgePeople(tx, state, stateApply,
   people)` (`services/person-purge.ts`); the Purge button calls it with one
   person, the sweep with the queue. `purgeableProjects` takes the batch.
2. `SpamPurgeService.sweep(now)` + a plugin on the event-reminders pattern
   (on ready, then every 24h; off in tests).

## Validation

- [x] `npm run type-check && npm run lint && npm test` clean.
- [x] Tests: queue selection (fresh vote, a legit vote, reactivated and
  staff are held back); one commit by `cfp-api` listing the slugs; a
  project only the batch touched goes; an empty queue writes nothing;
  `purgeAfter` dates.
- [x] Devbox: the roster shows the chip on spam-voted members.

## Risks / unknowns

- A queue that changes between the read and the write mutex skips that
  day's run rather than purging a stale set.

## Notes

- Sized on devbox against a copy of production `published` (12958c930,
  2026-10-15): the first sweep purged **27** accounts in one `cfp-api`
  commit (`people: scheduled spam purge (27)`, 35 files), none with a
  project only they touched. The 39 accounts voted spam that day showed
  "Purges Oct 18, 2026" on the roster.
- The roster intro said "the next pipeline run removes them"; it now
  describes the three-day purge.

## Follow-ups

- **Issue-worthy, not filed:** a vote response could return the row's new
  `purgeAfter` so the chip appears without a reload.
