---
status: in-progress
depends: [person-deactivate-purge, spam-prune]
specs:
  - specs/screens/admin-members.md
  - specs/api/moderation.md
  - specs/behaviors/spam-exclusion.md
  - specs/behaviors/person-lifecycle.md
issues: []
pr: null
---

# Plan: admin members roster + human spam votes

## Scope

Staff need one place to see who joined recently, what they've done on the site,
and to record a human spam/not-spam judgment that the offline pipeline treats
as final. Decisions taken 2026-09-18 with Chris:

- The page shows the member's **footprint**, not machine evaluations — anyone
  listed has already passed (or post-dates) the pipeline.
- A **spam vote deactivates immediately**; the pipeline hard-deletes later.
  A legit vote reverses a vote-set deactivation only.
- Staff see the member's **email** (already a staff-visible field).
- Route is **`/admin/members`**, open to staff and administrators.
- Machine evaluations and Slack-derived inputs move to a **private repo**
  (codeforphilly-data issue); the public repo carries only human votes.

In: the two read endpoints, the vote endpoint with its lifecycle side effect,
loading `person-evaluations` (human votes) from `published`, the screen.
Out: machine verdicts on the page; bulk actions; in-process heuristic at
signup; the private-repo migration itself (tracked on the data repo).

## Implements

- [screens/admin-members.md](../specs/screens/admin-members.md)
- [api/moderation.md](../specs/api/moderation.md)
- [behaviors/spam-exclusion.md](../specs/behaviors/spam-exclusion.md) —
  human votes on `published`; the "human vote is final" aggregation clause.
- [behaviors/person-lifecycle.md](../specs/behaviors/person-lifecycle.md) —
  vote-driven deactivate and its reversal rule.

## Approach

1. **Data repo first**: add `.gitsheets/person-evaluations.toml` (same schema
   as the pipeline's, so records are interchangeable) to `empty` and
   `published`. The importer/prune never touch this sheet.
2. **Schema**: `PersonEvaluation` in `packages/shared` (verdict, evaluator,
   confidence?, score?, flags, reasoning?, evaluatedAt, personSlug).
3. **Store**: register the sheet in `store/public.ts`; add
   `personEvaluations` + `evaluationsByPerson` to `InMemoryState`, state-apply,
   and the hot-reload swap (the swap enumerates `Object.keys(fresh)`, so the new
   maps are covered automatically — add the integration assertion anyway).
4. **Services**: `moderation` service — roster query (sort/filter/paginate over
   people + private profiles + vote index), footprint assembly from existing
   indices (`membershipsByPerson`, updates/buzz/blog by author, interest,
   tag-assignments), and `castVote()` inside the write mutex: upsert the
   `human-<voter>` record, apply the deactivate/reactivate rule, one commit
   authored by the voter.
5. **Routes**: `apps/api/src/routes/moderation.ts` — three endpoints, staff
   guard that 404s. Reuse the people serializer's staff-visible fields.
6. **Web**: `pages/AdminMembers.tsx` (+ `AdminMemberDetail`), routes
   `/admin/members` and `/admin/members/:slug`, guarded like the staff queue;
   nav entry for staff.
7. **Pipeline**: `prune-spam` reads human votes from `published` in addition to
   machine records (`--evaluations-ref` stays for the private clone); update
   `docs/operations/spam-detection.md` for the two-repo layout.

## Validation

- API: staff sees roster/footprint/email, non-staff and anonymous get 404 on
  all three; vote writes a `human-<slug>` record and deactivates; legit vote
  after spam reactivates; legit vote after self-deactivate does not; self-vote
  422; re-voting replaces the caller's record; hot reload keeps the vote index.
- Web: roster renders, filters work, vote buttons update row state, own row
  disabled; a11y pass on the grid (landmarks, button names).
- Prune: a person with a human `spam` vote is pruned even with a membership;
  a human `legit` vote protects against a confident machine spam verdict.
- `npm run type-check && npm run lint && npm test` clean; browser check on
  sandbox.

## Follow-ups

- Tracked as: codeforphilly-data issue (private repo migration).
- Deferred to plan: in-process heuristic scoring at signup.
