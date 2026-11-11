---
status: planned
depends: [scheduled-spam-purge, admin-members-moderation, sheet-contracts]
specs:
  - specs/api/agents.md
  - specs/api/moderation.md
  - specs/api/people.md
  - specs/behaviors/authorization.md
  - specs/behaviors/person-lifecycle.md
  - specs/behaviors/spam-exclusion.md
  - specs/behaviors/storage.md
  - specs/behaviors/private-storage.md
  - specs/data-model.md
  - specs/screens/admin-members.md
---

# Plan: Staged spam votes from an agent (the ops bot)

## Scope

Chris (2026-11-11), replying to the ops bot's flag of a spam sign-up: "let's
build a tool where you can apply 'spam' and 'not spam' votes as our screen in
/admin/members enables. Those rulings stage for 3 days so you can freely set
them as you see evidence."

Today only a staff session can vote, the only way into a session is a browser
GitHub sign-in, and every vote is recorded as `human-<slug>`. This plan gives
an automated moderator its own narrow way in and its own label, and makes the
three-day window a review window people can see and act on.

**In:**

- Agent accounts and **agent grants**: a public `agent-grants` sheet (contract
  `codeforphilly.org/agent-grants/v1`), token hashes in the private store, and
  the admin endpoints in `api/agents.md` (create agent, mint, revoke, list,
  withdraw staged votes).
- Session middleware: `Authorization: Bearer cfpa_…` resolves to an agent
  principal that satisfies only `agent:<scope>` markers; `401 grant_invalid`
  otherwise; header redacted from logs.
- Moderation: `staff | agent:…` on the three member endpoints; `DELETE …/vote`
  for agents; `agent-<slug>` evaluator; the agent vote rules (humans final,
  `user` only, 30-day member age for `spam`, 20 spam votes / 24h, required
  reasoning, flags); agent-caller redaction (`email` null, `emailDomain`,
  domain-only `q`); `stagedVote`, `emailDomain`, `vote=staged`, `kind` on
  detail votes.
- Lifecycle: "deciding votes" (humans if any, else agents with an active
  grant) in the reversal rule, `spamPurgeDueAt` and the sweep; agent accounts
  excluded from the sweep and from votes; `Agent-Staged` trailer and
  `(staged by …)` lines on the sweep commit.
- Commit metadata: `Actor-Kind: agent` + `Grant-Id` trailers.
- `account-level` refuses to raise an agent account.
- `prune-spam`: `agent-*` `legit` protects; `agent-*` `spam` ignored.
- `/admin/members`: staged badge with reasoning and flags, buttons kept on
  staged rows, "staged by an agent" filter, "Hidden by {agent} (AI)", history
  labels, the Agents panel (show staged, withdraw, mint/revoke/new agent).

**Out:**

- The bot-side command and loop policy — the `grittybot` repo, described
  below, its own plan there after this ships.
- Creating the production agent account and minting its grant — an operator
  step after deploy (Rollout below), not code.
- A public "AI agent" chip on `/members/<slug>` — follow-up; the agent's bio
  says it for now.
- Clearing a human vote; bulk staff actions; scopes beyond moderation.
- The existing gap that a spam-hidden member can self-reactivate from
  `/account` and so leave the purge queue — true of staff votes today; worth
  its own spec decision, not this plan's.

## Implements

- [api/agents.md](../specs/api/agents.md) — every endpoint; the agent account
  rules (no sign-in identity, never staff, never voted on or swept); grant
  token format, hashing, expiry, revocation, `lastUsedAt`.
- [api/moderation.md](../specs/api/moderation.md) — auth column, `vote=staged`,
  `emailDomain`, `stagedVote`, `purgeAfter` on deciding votes, `kind` on
  detail votes, agent request fields, `DELETE …/vote`, Agent callers, Agent
  votes (rules 1–5), new errors.
- [api/people.md](../specs/api/people.md) — `agent_account` refusal on
  account-level.
- [behaviors/authorization.md](../specs/behaviors/authorization.md) —
  `agent:<scope>` marker; Agent grants.
- [behaviors/person-lifecycle.md](../specs/behaviors/person-lifecycle.md) —
  deciding votes, reversal rule, staged purge, sweep commit shape.
- [behaviors/spam-exclusion.md](../specs/behaviors/spam-exclusion.md) —
  evaluator kinds; agent votes never prune.
- [behaviors/storage.md](../specs/behaviors/storage.md) — agent commit trailers.
- [behaviors/private-storage.md](../specs/behaviors/private-storage.md) —
  `agent-grant-secrets.jsonl`.
- [data-model.md](../specs/data-model.md) — `AgentGrant`; `PersonEvaluation`
  pointer.
- [screens/admin-members.md](../specs/screens/admin-members.md) — staged rows,
  filter, history labels, Agents panel.

## Approach

1. **Schema + sheet.** `AgentGrantSchema` in `packages/shared` (Zod, with
   `references('people.slug')` on `personSlug`), `AGENT_EVALUATOR_PREFIX`,
   `agentEvaluatorFor`, `isAgentEvaluator`, and an `evaluatorKind()` that
   returns `human | agent | machine`. Generate the `agent-grants/v1` contract
   the way `sheet-contracts` does; add `apps/api/gitsheets/agent-grants.toml`.
   Data repo: prepare the sheet config on `empty`, `fixture`,
   `legacy-import`, `published` before the API deploy that reads it (as
   `person-evaluations-contract` did).
2. **State.** Load `agent-grants` into in-memory state (`agentGrants`,
   `agentGrantsByPerson`) in the loader, incremental reload and
   `StateApply`; add it to the slug-rename reference cascade and the purge
   cascade (a purged agent loses its grants and secrets). Private store:
   `agent-grant-secrets.jsonl` with `getGrantSecretByHash`, `putGrantSecret`,
   `deleteGrantSecretsFor(personId)`; build a `Map<hash, grantId>` at boot.
3. **Auth.** In `auth/middleware.ts`, before the cookie: a `Bearer cfpa_`
   header → hash → grant → checks → `SessionContext` with `person` = agent,
   `accountLevel: 'user'`, and `agent: { grantId, scopes }`. Grant + cookie
   together → 401. `requireAuth` / `requireAuthMarker` gain
   `agent:<scope>`; every existing marker treats a session with `agent` set
   as anonymous (one guard at the top, so no route can forget). Redact
   `authorization` in the Fastify logger config. Throttle `lastUsedAt` writes
   to one an hour.
4. **Moderation service.** `decidingVotes(state, slug, now)` used by
   `castVote`'s reversal check, `spamPurgeDueAt`, `stagedVote` and the vote
   filter, so there is one definition. `castVote` takes the caller kind; the
   agent path runs rules 1–4 inside the mutex (rate count from the agent's
   own records), writes `agent-<slug>` with `["agent", …flags]` and required
   reasoning. `withdrawVote` for `DELETE`. Agent read redaction in `#row` and
   the detail route. `spamPurgeDueAt` needs grant state (active grant per
   agent) — pass it in with `state`.
5. **Commit meta.** `buildTransactionOptions` adds `Actor-Kind: agent` and
   `Grant-Id` when `session.agent` is set. Sweep message lists
   `(staged by agent-<slug>)` and the `Agent-Staged` trailer.
6. **Agents routes.** `routes/agents.ts` + `services/agents.ts` per
   `api/agents.md`; create-agent writes person + empty private profile +
   grant + secret in one dual-store transaction; `withdraw-votes` deletes and
   reactivates in one commit.
7. **people.account-level** refuses agent accounts.
8. **prune-spam** `foldEvaluation`: `agent-*` legit → `hasAnyLegit`; agent spam
   skipped; test both.
9. **Web.** `AdminMembers.tsx`: staged badge, reasoning line, flag chips,
   buttons on staged rows, filter option, history labels, Agents panel with
   the once-only token dialog.
10. **Docs.** `docs/operations/` — a short "Agents" runbook: create the agent,
    mint, hand the token to its host, rotate, revoke, withdraw.

The work fits one PR; if review prefers smaller pieces, split at 1–5 (API,
no UI: agents can vote, the existing roster shows staged spam as an
unlabeled hide) — **don't ship that half alone to production**, since the
review window is only real once step 9 lands.

## Validation

- [ ] `npm run type-check && npm run lint && npm test` clean.
- [ ] Auth tests: a valid grant reaches `GET /api/admin/members` and
  `POST …/vote`; the same token is refused (401) on `user`-marked routes
  (e.g. `PATCH /api/people/:slug`), `POST /api/auth/refresh` mints nothing
  from it, and public reads see it as anonymous; revoked, expired, deactivated-agent and grant+cookie all
  401 `grant_invalid`; a grant without `moderation:vote` gets 404 on vote.
- [ ] The token never appears in the commit, the private store (only its
  hash), or a captured request log line.
- [ ] Vote rules: agent vote on a human-voted member → 409
  `human_verdict_exists`; on staff/agent/self → 409/422; spam on a member
  older than 30 days → 409 `member_too_old`; 21st spam vote in 24h → 429
  with `Retry-After`; missing reasoning → 422.
- [ ] Side effects: agent spam hides; agent legit / `DELETE` un-hides only
  when the agent's spam hid them; a staff `legit` on a staged member
  un-hides and stops the purge; a staff `spam` confirms and moves
  `purgeAfter` to its own date.
- [ ] Sweep: an agent-only spam member ≥ 3 days with an active grant is
  purged, listed `(staged by agent-<slug>)`, `Agent-Staged: 1`; with the
  grant revoked, not queued and `stagedVote.counts = false`; agent accounts
  never queued.
- [ ] Commit for an agent vote: author is the agent's pseudonymous identity,
  subject `<agent>: POST /api/admin/members/<slug>/vote`, trailers include
  `Actor-Kind: agent`, `Grant-Id`, `Actor-Account-Level: user`.
- [ ] `withdraw-votes`: one commit; counts right; votes on human-voted
  members untouched.
- [ ] account-level refuses to raise an agent (`409 agent_account`).
- [ ] prune-spam: agent legit protects; agent spam does not prune.
- [ ] Contract: `gitsheets contracts verify` clean on every data-repo branch
  with the `agent-grants` config; boot fails loudly without it.
- [ ] Browser (devbox): create an agent, mint (token shown once), vote with
  `curl` as the agent, see the staged badge with reasoning in the default
  roster view, overrule with Not spam, withdraw, revoke.

## Risks / unknowns

- **A leaked token** can hide up to 20 new members a day until noticed.
  Bounded by the age rule (no established member), the daily cap, the
  agent's account and reasoning on every row, hiding being reversible, and
  three days before anything deletes; recovery is revoke (purges stop at
  once) then withdraw (hidden members return), both one click.
- **Nobody looks during the three days.** The window is only a safeguard if
  someone reviews. The bot side reports each vote to the operators' channel
  and the members nearing purge (below); the roster's default view includes
  staged rows.
- **An agent arguing with staff.** Rule 1 makes that impossible on the site;
  the bot's own policy must still not re-vote someone a human cleared
  (it can't — 409 — but it should not retry).
- **Data-repo ordering.** The API must not boot against a branch without the
  `agent-grants` config; land the data-repo commits first (as
  `person-evaluations-contract` did).
- **`lastUsedAt` writes** to the private store on a polling agent; throttled
  to one an hour per grant.

## Bot side (grittybot repo, separate plan after this ships)

A small command, `bin/member-vote`, the bot's only way to vote:

```
bin/member-vote show <slug>                       # roster row + votes, JSON
bin/member-vote <slug> spam|not-spam --reason "…" [--flag <tag>]… [--dry-run]
bin/member-vote <slug> clear                      # DELETE its own vote
bin/member-vote staged                            # its staged votes and purge dates
```

- **Credential:** `~/.config/grittybot/cfp-agent-token`, mode 0600, beside the
  Slack app token, never in the repo, read by the command only; the site base
  URL in `opsbot.json` (`site.base_url`). The operator mints the grant and
  places the file; the bot never sees a person's credential and holds no
  site session.
- **Output:** the API's result plus the purge date, one JSON line appended to
  the cycle log; a refusal (409/429) is reported as such, never retried
  around.
- **Visibility:** every vote it casts is posted to `#grittybot-hq` in the same
  cycle (member slug, verdict, reasons, purge date, roster link); once a day,
  a list of its staged votes that purge within 24 hours. That is what makes
  the three days a review window in practice.
- **When it votes (loop policy, in the bot's specs):** from the
  `30-data-commits` stream's `new-member` and `profile-edit` items, it votes
  `spam` only when at least two independent signals agree and none
  contradicts, e.g. a business or brand name as the member name; a GitHub
  account hours old (`author-account-<n>h-old`) or the roster's
  `github-new-account` / `github-no-activity`; a promotional link added to
  the bio minutes after sign-up (`bio-added-link`, `has-link`); a throwaway
  `emailDomain`; a slug a purge removed before (`slug-purged-before`). It
  does **not** vote spam on anyone with a project footprint shared with
  other people, anyone who has signed into Slack, or anyone it is talking
  to; those it flags to the operators instead. It votes `not-spam` or
  `clear` when new evidence contradicts its staged vote (a real project, a
  human vouching), at once.
- **Rules change in the bot repo:** the bot's non-negotiables gate deletes
  on the operator's gate word. Record the operator's 2026-11-11 direction
  that a staged member vote is not a delete (the site's three-day window and
  human overrule are the gate) as a reviewed PR to the bot's protocols; a
  person merges it.

## Rollout

1. Data repo: `agent-grants` sheet config on every branch.
2. Release + deploy (sandbox first; sandbox shares `published` but does not
   sweep).
3. An administrator creates the agent account on production with a bio
   saying it is an AI run by Code for Philly, mints a
   `moderation:read, moderation:vote` grant (90 days), and places the token
   on the bot's host.
4. The bot ships `bin/member-vote` and its policy; first week, it posts every
   vote and the operator reviews the lot.

## Notes

## Follow-ups
