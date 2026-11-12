---
status: planned
depends: [scheduled-spam-purge, admin-members-moderation, sheet-contracts]
specs:
  - specs/api/agents.md
  - specs/api/auth.md
  - specs/api/moderation.md
  - specs/api/people.md
  - specs/behaviors/authorization.md
  - specs/behaviors/person-lifecycle.md
  - specs/behaviors/spam-exclusion.md
  - specs/behaviors/storage.md
  - specs/behaviors/private-storage.md
  - specs/data-model.md
  - specs/screens/admin-members.md
  - specs/screens/login.md
---

# Plan: Agent moderation for the ops bot (staged spam votes, posted-spam purges)

## Scope

Chris (2026-11-11), replying to the ops bot's flag of a spam sign-up: "let's
build a tool where you can apply 'spam' and 'not spam' votes as our screen in
/admin/members enables. Those rulings stage for 3 days so you can freely set
them as you see evidence."

Chris (2026-11-12), the policy this plan implements: "When someone actually
posts spam, purge immediately. For signups that are obviously spam but haven't
posted anything spammy, log a spam vote to put them in the 3-day purge queue
pending doing anything that makes them not look like spam."

Read as two cases:

- **Posted spam**: the account itself put spam content on the site — a
  promotional bio or link in it, a spam project, update, buzz item or
  help-wanted role. The agent **purges at once**.
- **Looks like spam, nothing posted**: a business or site name as the member
  name, a throwaway GitHub account. The agent **casts a spam vote**; the member
  is hidden and sits in the three-day queue, purged at the end unless
  something makes them not look like spam.

Two recent cases the design is tested against (described generically):

1. An account signed up under a business name and, 90 seconds later, set a
   promotional bio with a link. Staff purged it. Nine hours later the same
   GitHub account signed up again, got the same slug, and posted the same bio
   within 80 seconds.
2. An account signed up under a site name, self-joined an existing project as
   a plain member, and within 70 seconds set a bio advertising a streaming
   site, with a link.

Today only a staff session can vote or purge, the only way into a session is a
browser GitHub sign-in, every vote is recorded as `human-<slug>`, and a purged
GitHub account signs straight back in (case 1). This plan gives an automated
moderator its own narrow way in and its own label, a fenced purge for posted
spam, a public log of spam purges that also blocks the purged GitHub account
from signing up again, and fixes votes from a purged account attaching to a
new account with the same slug.

**In:**

- Agent accounts and **agent grants**: a public `agent-grants` sheet (contract
  `codeforphilly.org/agent-grants/v1`), token hashes in the private store, and
  the admin endpoints in `api/agents.md` (create agent, mint, revoke, list,
  withdraw staged votes). Three scopes: `moderation:read`, `moderation:vote`,
  `moderation:purge` (purge needs read; never implied).
- Session middleware: `Authorization: Bearer cfpa_…` resolves to an agent
  principal that satisfies only `agent:<scope>` markers; `401 grant_invalid`
  otherwise; header redacted from logs.
- **Votes** (the "looks like spam" case): `staff | agent:…` on the member
  endpoints; `DELETE …/vote` for agents; `agent-<slug>` evaluator; the agent
  vote rules (humans final, `user` only, 30-day member age for `spam`, 20 spam
  votes / 24h, required reasoning, flags); agent-caller redaction (`email`
  null, `emailDomain`, domain-only `q`); `stagedVote`, `emailDomain`,
  `vote=staged`, `kind` on detail votes.
- **Agent purge** (the "posted spam" case): `POST /api/admin/members/:slug/purge`
  with `reason` (no URL), `flags`, 1–5 `evidence` items the API verifies, and
  `dryRun`; the eight agent purge rules (signed-up `user` only, joined ≤ 7
  days, no human vote, no standing `legit` vote, no Slack sign-in, no shared
  project, evidence goes with the purge, 5 / 24h); one commit per purge with
  `Purge-Id` and `Evidence` trailers; the agent's vote record written as the
  "why".
- **`spam-purges` sheet** (contract `codeforphilly.org/spam-purges/v1`):
  written by agent purges, by the scheduled sweep, and by a staff purge marked
  as spam (`{ spam: true, reason }` on `POST /api/people/:slug/purge`; a
  checkbox in the Danger Zone dialog). `GET /api/admin/spam-purges` and
  `POST /api/admin/spam-purges/:id/unblock`.
- **Re-registration block** (case 1): the GitHub callback refuses
  `signup_blocked` for a GitHub id an active `spam-purges` record blocks, and
  link-GitHub refuses `github_blocked`; `/login` shows the message.
- **Votes belong to one account** (a fix): votes with `evaluatedAt` earlier
  than the person's `createdAt` are an earlier account's and count for nothing
  — in the roster fields, deciding votes, the reversal rule, agent rules, the
  sweep and the offline prune. New `slug-purged-before` signal; detail
  `earlierVotes` / `earlierPurges`.
- Lifecycle: "deciding votes" (humans if any, else agents with an active
  grant) in the reversal rule, `spamPurgeDueAt` and the sweep; agent accounts
  excluded from the sweep, votes and purges; `Agent-Staged` trailer and
  `(staged by …)` lines on the sweep commit; sweep writes `spam-purges`.
- Commit metadata: `Actor-Kind: agent` + `Grant-Id` trailers.
- `account-level` refuses to raise an agent account.
- `prune-spam`: `agent-*` `legit` protects; `agent-*` `spam` ignored; votes
  older than the person ignored.
- `/admin/members`: staged badge with reasoning and flags, buttons kept on
  staged rows, "staged by an agent" filter, "Hidden by {agent} (AI)", history
  labels, `Slug purged before` badge and Earlier account block, the recent
  agent purges banner, the Agents panel (show staged, purge counts, withdraw,
  mint/revoke/new agent, second confirm for a purge grant) and its purge log
  (reason, evidence links, commit link, unblock).
- `docs/operations/runbook.md`: "Agents" (create, mint, rotate, revoke,
  withdraw) and "Restore a purged member".

**Out:**

- The bot-side command and loop policy — the `grittybot` repo, described
  below, its own plan there after this ships.
- Creating the production agent account and minting its grants — operator
  steps after deploy (Rollout below), not code.
- A staff "Restore" button. Restores follow the runbook (git revert, unblock,
  Not spam); a `POST /api/admin/spam-purges/:id/restore` is a follow-up if
  restores become routine.
- A public "AI agent" chip on `/members/<slug>` — follow-up; the agent's bio
  says it for now.
- Email or Slack notification from the site to staff on an agent purge — the
  bot posts each one to its operators' channel, and the roster banner shows
  them for seven days.
- Clearing a human vote; bulk staff actions; scopes beyond moderation.
- Recording who added a project membership (`addedBySlug`): would let the API
  tell a maintainer-added member from a self-joiner; the bot reads it from the
  commit author for now.
- The existing gap that a spam-hidden member can self-reactivate from
  `/account` and so leave the purge queue — true of staff votes today; worth
  its own spec decision, not this plan's.
- The existing gap that the purge cascade leaves help-wanted roles a purged
  person posted on a project the purge keeps. Agent purges cannot reach it
  (posting a role needs a maintainer, and maintaining a shared project blocks
  the purge); a staff purge can.
- The private store's missing versioning in production (see Risks): the
  `private-storage.md` claim that production buckets are versioned does not
  hold for the filesystem PVC in use. Not this plan's to fix; it limits what a
  restore recovers.

## Implements

- [api/agents.md](../specs/api/agents.md) — every endpoint (list now staff);
  the agent account rules (no sign-in identity, never staff, never voted on,
  purged or swept); the three scopes and purge-needs-read; token format,
  hashing, expiry, revocation, `lastUsedAt`; `purges` counts on the list.
- [api/moderation.md](../specs/api/moderation.md) — auth column; Votes belong
  to one account; `slug-purged-before`; `vote=staged`, `emailDomain`,
  `stagedVote`, `purgeAfter` on deciding votes; `kind`, `earlierVotes`,
  `earlierPurges` on detail; agent vote fields, `DELETE …/vote`; Agent
  callers; Agent votes (rules 1–5); `POST …/purge` and Agent purges (rules
  1–8, effects, commit); `GET /api/admin/spam-purges`; `POST …/unblock`.
- [api/people.md](../specs/api/people.md) — purge body `{ spam, reason }`;
  `agent_account` refusal on account-level.
- [api/auth.md](../specs/api/auth.md) — callback "Purged as spam" check,
  `signup_blocked`; link-GitHub `github_blocked`.
- [behaviors/authorization.md](../specs/behaviors/authorization.md) —
  `agent:<scope>` marker; Agent grants; purge is its own scope.
- [behaviors/person-lifecycle.md](../specs/behaviors/person-lifecycle.md) —
  deciding votes (this account only), reversal rule, staged purge, Agent
  purge, spam or not on staff purge, sweep writes `spam-purges`, Restoring a
  purged member, authorization summary.
- [behaviors/spam-exclusion.md](../specs/behaviors/spam-exclusion.md) —
  evaluator kinds; agent votes never prune; agent purge records; earlier
  account's votes ignored.
- [behaviors/storage.md](../specs/behaviors/storage.md) — agent commit
  trailers, agent purge trailers.
- [behaviors/private-storage.md](../specs/behaviors/private-storage.md) —
  `agent-grant-secrets.jsonl`.
- [data-model.md](../specs/data-model.md) — `AgentGrant` (three scopes);
  `PersonEvaluation` account rule; `SpamPurge`.
- [screens/admin-members.md](../specs/screens/admin-members.md) — staged rows,
  filter, history labels, `Slug purged before`, Earlier account, recent agent
  purges banner, Agents panel, purge log.
- [screens/login.md](../specs/screens/login.md) — `signup_blocked` message.

## Approach

1. **Votes belong to one account** (a fix that stands alone; land first if
   split). One helper, `votesOnAccount(state, person)`, filtering
   `evaluationsByPerson` to `evaluatedAt >= person.createdAt`; use it in
   `spamPurgeDueAt`, `latestHumanVerdict`, the roster's vote fields and the
   vote filter. `prune-spam` applies the same filter. Tests: a re-registered
   slug with an old staff spam vote shows no `latestVote`, is not queued when
   deactivated, and lists the vote under `earlierVotes`.
2. **Schema + sheets.** `AgentGrantSchema` and `SpamPurgeSchema` in
   `packages/shared` (Zod; `references('people.slug')` on
   `AgentGrant.personSlug`, **no** reference on `SpamPurge.personSlug`),
   `AGENT_EVALUATOR_PREFIX`, `agentEvaluatorFor`, `isAgentEvaluator`, and an
   `evaluatorKind()` that returns `human | agent | machine`. Generate the
   `agent-grants/v1` and `spam-purges/v1` contracts the way `sheet-contracts`
   does; add `apps/api/gitsheets/agent-grants.toml` and `spam-purges.toml`.
   Data repo: prepare both sheet configs on `empty`, `fixture`,
   `legacy-import`, `published` before the API deploy that reads them (as
   `person-evaluations-contract` did).
3. **State.** Load `agent-grants` (`agentGrants`, `agentGrantsByPerson`) and
   `spam-purges` (`spamPurges`, `spamPurgesByGithubUserId`, `spamPurgesBySlug`)
   in the loader, incremental reload and `StateApply`; add `agent-grants` to
   the slug-rename reference cascade (not `spam-purges`) and the purge cascade
   (a purged agent loses its grants and secrets). Private store:
   `agent-grant-secrets.jsonl` with `getGrantSecretByHash`, `putGrantSecret`,
   `deleteGrantSecretsFor(personId)`; build a `Map<hash, grantId>` at boot.
4. **Auth.** In `auth/middleware.ts`, before the cookie: a `Bearer cfpa_`
   header → hash → grant → checks → `SessionContext` with `person` = agent,
   `accountLevel: 'user'`, and `agent: { grantId, scopes }`. Grant + cookie
   together → 401. `requireAuth` / `requireAuthMarker` gain
   `agent:<scope>`; every existing marker treats a session with `agent` set
   as anonymous (one guard at the top, so no route can forget). Redact
   `authorization` in the Fastify logger config. Throttle `lastUsedAt` writes
   to one an hour. In `auth/github-oauth.ts`, `completeCallback` checks
   `spamPurgesByGithubUserId` after `resolveIdentity` returns anything but
   `existing` → `signup_blocked`; `completeLinkCallback` → `github_blocked`.
5. **Moderation service: votes.** `decidingVotes(state, slug, now)` (on top
   of step 1) used by `castVote`'s reversal check, `spamPurgeDueAt`,
   `stagedVote` and the vote filter, so there is one definition. `castVote`
   takes the caller kind; the agent path runs rules 1–4 inside the mutex
   (rate count from the agent's own records), writes `agent-<slug>` with
   `["agent", …flags]` and required reasoning. `withdrawVote` for `DELETE`
   (409 once a human has voted). Agent read redaction in `#row` and the
   detail route. `spamPurgeDueAt` needs grant state (active grant per agent) —
   pass it in with `state`. `slug-purged-before` signal from
   `spamPurgesBySlug`.
6. **Moderation service: agent purge.** `agentPurge(tx, session, slug, body)`
   in `services/moderation.ts`: validate body (reason without URL — a plain
   `https?://` or `www.` test plus bare-domain-with-path), resolve each
   evidence item to its record and data-repo path, check ownership and
   non-empty field; then rules 1–8 inside the mutex. Reuse `purgePeople` from
   `services/person-purge.ts` for the cascade and a dry-run variant of
   `purgePreview` for rule 7 ("goes with the purge") and the `deleted`
   counts. Write the agent's evaluation and the `spam-purges` record in the
   same transaction; `beforeCommit` is the data repo HEAD read under the lock
   (verify gitsheets exposes it — see Risks). Route in `routes/moderation.ts`.
7. **Staff purge + sweep.** `POST /api/people/:slug/purge` accepts
   `{ spam, reason }` and writes a `spam-purges` record when `spam`; the
   sweep writes one per purged person (`by = "scheduled"`, reason naming the
   deciding voters).
8. **Spam-purges routes.** `GET /api/admin/spam-purges` (filters, `url`s
   built from the configured data repo GitHub URL + `beforeCommit` + path,
   `commitUrl` to the record path's history) and `POST …/unblock`.
9. **Commit meta.** `buildTransactionOptions` adds `Actor-Kind: agent` and
   `Grant-Id` when `session.agent` is set, plus `Purge-Id` and `Evidence`
   trailers for an agent purge, reason as body. Sweep message lists
   `(staged by agent-<slug>)` and the `Agent-Staged` trailer.
10. **Agents routes.** `routes/agents.ts` + `services/agents.ts` per
    `api/agents.md`; create-agent writes person + empty private profile +
    grant + secret in one dual-store transaction; `withdraw-votes` deletes
    and reactivates in one commit, skipping purged slugs; mint refuses
    `moderation:purge` without `moderation:read`.
11. **people.account-level** refuses agent accounts.
12. **prune-spam** `foldEvaluation`: `agent-*` legit → `hasAnyLegit`; agent
    spam skipped; earlier-account votes skipped; test all three.
13. **Web.** `AdminMembers.tsx`: staged badge, reasoning line, flag chips,
    buttons on staged rows, filter option, history labels, `Slug purged
    before` badge and Earlier account block, recent agent purges banner,
    Agents panel with the once-only token dialog and the purge-grant second
    confirm, purge log with Unblock. Danger Zone purge dialog: the "This was
    spam" checkbox. `/login`: `signup_blocked` message.
14. **Docs.** `docs/operations/runbook.md` — "Agents" (create the agent, mint,
    hand the token to its host, rotate, add or drop the purge scope, revoke,
    withdraw) and "Restore a purged member" (the steps in
    `person-lifecycle.md`).

The work fits one PR but splits cleanly: **(a)** step 1 alone (a bug fix
today); **(b)** steps 2–5, 9–12 and the vote half of 13 (agents can vote);
**(c)** steps 6–8 and the rest of 13–14 (agent purge, the purge log, the
sign-up block). Don't ship (b) to production without its UI — the review
window is only real once staff can see staged votes — and don't mint a purge
grant before (c)'s purge log is live.

## Validation

- [ ] `npm run type-check && npm run lint && npm test` clean.
- [ ] Auth tests: a valid grant reaches `GET /api/admin/members` and
  `POST …/vote`; the same token is refused (401) on `user`-marked routes
  (e.g. `PATCH /api/people/:slug`), `POST /api/auth/refresh` mints nothing
  from it, and public reads see it as anonymous; revoked, expired,
  deactivated-agent and grant+cookie all 401 `grant_invalid`; a grant
  without `moderation:vote` gets 404 on vote; without `moderation:purge`, 404
  on purge; minting purge without read → 422.
- [ ] The token never appears in the commit, the private store (only its
  hash), or a captured request log line.
- [ ] Vote rules: agent vote on a human-voted member → 409
  `human_verdict_exists`; on staff/agent/self → 409/422; spam on a member
  older than 30 days → 409 `member_too_old`; 21st spam vote in 24h → 429
  with `Retry-After`; missing reasoning → 422; `DELETE` after a human vote →
  409.
- [ ] Side effects: agent spam hides; agent legit / `DELETE` un-hides only
  when the agent's spam hid them; a staff `legit` on a staged member
  un-hides and stops the purge; a staff `spam` confirms and moves
  `purgeAfter` to its own date.
- [ ] **Case 1 fixture**: a member created 2 minutes ago with a business name
  and a bio with a link; agent purge citing `person#bio` → 200, one commit,
  person and avatar gone, `spam-purges` record with `githubUserId`,
  `blocksSignIn`; the reason's URL check rejects a reason containing the
  link. A GitHub callback for the same `gh.id` → redirect
  `/login?error=signup_blocked`, nothing written. After `unblock`, the
  callback creates a fresh person; the roster shows `slug-purged-before`, no
  `latestVote`, and the old votes under `earlierVotes`. The same flow with a
  staff Danger Zone purge (`spam: true`) blocks the same way; with
  `spam: false`, no record and no block.
- [ ] **Case 2 fixture**: a 1-minute-old member who self-joined another
  person's project (not maintainer) and set a promotional bio → agent purge
  200; their membership is gone; the project, its other members and their
  records are unchanged.
- [ ] Agent purge refusals: member 8 days old → `member_too_old`; any human
  vote (spam or legit) → `human_verdict_exists`; an agent `legit` →
  `legit_vote_exists`; `lastSlackSsoAt` set → `established_member`; created a
  project someone else joined, or maintains a project with another member →
  `shared_project`; evidence on a record not theirs or empty →
  `evidence_invalid`; evidence on a project the purge keeps →
  `evidence_survives`; imported member → `protected_account`; 6th purge in
  24h → 429. Each refusal writes nothing. `dryRun: true` passes or fails the
  same and writes nothing.
- [ ] Agent purge commit: author the agent's pseudonymous identity; subject
  `<agent>: POST /api/admin/members/<slug>/purge`; body the reason; trailers
  `Action: person.purge`, `Actor-Kind: agent`, `Grant-Id`, `Purge-Id`, one
  `Evidence:` per item; `git show <sha>^:<evidence path>` shows the spam.
- [ ] Sweep: an agent-only spam member ≥ 3 days with an active grant is
  purged, listed `(staged by agent-<slug>)`, `Agent-Staged: 1`, with a
  `spam-purges` record `by = "scheduled"`; with the grant revoked, not queued
  and `stagedVote.counts = false`; agent accounts never queued; a
  re-registered slug with only an earlier account's spam vote is never queued.
- [ ] Commit for an agent vote: author is the agent's pseudonymous identity,
  subject `<agent>: POST /api/admin/members/<slug>/vote`, trailers include
  `Actor-Kind: agent`, `Grant-Id`, `Actor-Account-Level: user`.
- [ ] `withdraw-votes`: one commit; counts right; votes on human-voted and on
  purged members untouched.
- [ ] account-level refuses to raise an agent (`409 agent_account`).
- [ ] prune-spam: agent legit protects; agent spam does not prune; an
  earlier account's human spam vote does not prune the new account.
- [ ] Contract: `gitsheets contracts verify` clean on every data-repo branch
  with the `agent-grants` and `spam-purges` configs; boot fails loudly
  without them.
- [ ] Restore runbook rehearsed on the devbox: agent-purge a fixture member,
  unblock, `git revert --no-commit` keeping `spam-purges/`, push, hot reload,
  vote Not spam, sign in as that GitHub user.
- [ ] Browser (devbox): create an agent, mint (token shown once; purge grant
  asks twice), vote and purge with `curl` as the agent, see the staged badge
  with reasoning in the default roster view, overrule with Not spam, see the
  banner and the purge log with evidence and commit links, unblock, withdraw,
  revoke; see `/login?error=signup_blocked`.

## Risks / unknowns

- **A wrong purge.** Unlike a vote, it acts before anyone looks. Bounded by
  the API rules (new, unestablished, unvoted, nothing shared, evidence the
  member authored), the 5-a-day cap, a public log with the reason and the
  spam as it stood, the banner, and the bot posting every purge to its
  operators. Recovery is the runbook: public records come back exactly; the
  **private profile does not** (no versioning or backup of the production
  PVC — `docs/operations/deploy.md`), so the person's email, newsletter choice
  and Slack link are lost and rebuilt on their next GitHub sign-in.
- **A leaked token.** With read + vote it can hide up to 20 new members a day;
  with purge, also delete up to 5 a day of members under 7 days old who
  authored something. Recovery: revoke (purges and staged purges stop at
  once), withdraw (hidden members return), restore any wrong purges by hand.
  The purge scope is why the first grant leaves it out (Rollout).
- **The API cannot judge content.** It checks that the cited record is the
  member's and non-empty, not that it is spam. A purge citing an innocent bio
  passes the API; the reason, evidence links and operator channel are what
  catch it. The narrow population (≤ 7 days, nothing shared, no Slack) keeps
  the cost of that small.
- **Nobody looks during the three days.** The window is only a safeguard if
  someone reviews. The bot side reports each vote to the operators' channel
  and the members nearing purge (below); the roster's default view includes
  staged rows.
- **An agent arguing with staff.** The rules make that impossible on the site;
  the bot's own policy must still not re-vote or purge someone a human
  cleared (it can't — 409 — but it should not retry).
- **Blocking a GitHub id is permanent until someone unblocks.** A person whose
  account was purged as spam by mistake can't sign up again and is told to
  email; staff unblock from the log.
- **`beforeCommit`.** The purge record wants the data repo commit it was
  applied on. If gitsheets' transaction does not expose its parent, read
  `HEAD` of the data branch under the write lock before transacting; verify
  in step 6.
- **Data-repo ordering.** The API must not boot against a branch without the
  `agent-grants` and `spam-purges` configs; land the data-repo commits first
  (as `person-evaluations-contract` did).
- **`lastUsedAt` writes** to the private store on a polling agent; throttled
  to one an hour per grant.

## Open questions

Each with a recommended answer. (The 2026-11-11 question "purge a bot-only
spam vote after three days with no person looking?" is answered by the
policy: yes.)

1. **Daily caps and age windows.** 20 spam votes / 24h on members under 30
   days; 5 purges / 24h on members under 7 days. *Recommend as written*: both
   real cases posted within two minutes of signing up.
2. **Should the agent see full emails?** *No*, the domain only.
3. **Create the agent as a site record, with no GitHub sign-in?** *Yes.*
4. **Should staff voting Spam on a staged row restart the three days?** *Yes*,
   the existing rule.
5. **Grant lifetime?** *90 days*, renewed by an administrator.
6. **Is purge a separate scope, and does the first grant carry it?**
   *Separate* (`moderation:purge`, never implied). *First grant: read + vote
   only.* Mint a read + vote + purge grant (and revoke the old one) once the
   purge log is live and the bot's rules change is merged.
7. **Does any human vote block an agent purge, or only "not spam"?** *Any.* A
   staff "not spam" must win; a staff "spam" already hid the member and set a
   clock the agent should not shorten.
8. **Does a project membership block an agent purge?** *Only a shared one*:
   creating a project someone else touched, or maintaining a project with
   another member. A plain self-join (case 2) does not block — joining is
   self-service and carries no maintainer's judgment; the membership goes and
   the project stays.
9. **Does a Slack sign-in block an agent purge?** *Yes* — the person got far
   enough to use the community; a human decides.
10. **Is the re-registration block in scope, and where does it live?** *In
    scope*, as a public `spam-purges` record checked at the GitHub callback,
    with a staff unblock. `githubUserId` is already public on every person
    record and in the purged record's history, so a public block list exposes
    nothing new and keeps the block auditable; the private store has no
    history in production. Not adopted: treating "slug or GitHub id purged
    before" as posted-spam evidence on its own — with the block, the same
    GitHub id cannot return, and a new GitHub account gets a new slug, so the
    rule would only matter after an unblock, which is exactly when it should
    not fire. The bot uses `slug-purged-before` as a strong vote signal.
11. **Should the scheduled sweep's purges also block sign-up?** *Yes*: three
    days unopposed is a spam verdict. A mistaken one is one Unblock click.
12. **Staff Danger Zone purge: "This was spam" checkbox default?** *Checked
    when the person has a spam vote on their current account, else
    unchecked*, so an erase-me request never lands on the block list by
    default.
13. **Restore: endpoint or runbook?** *Runbook now*; an endpoint if restores
    pass about one a month.
14. **Forbid URLs in a purge reason?** *Yes*, so the spam link is never
    republished in a permanent public commit; the evidence path points at it.
15. **Should the member's name or avatar count as posted-spam evidence?**
    *No.* A business name is the "looks like spam" case (a vote). Avatars are
    rarely the spam and are hard to review from a log; revisit if they become
    the vector.
16. **Ship the "votes belong to one account" fix with this plan or first?**
    *First, as its own small PR* (step 1): it is a bug for staff votes today
    (case 1's re-registration showed the earlier account's staff vote as its
    own).
17. **Should the site itself notify staff of an agent purge?** *Not yet*: the
    bot posts each purge to its operators' channel and the roster banner
    shows it for seven days. Revisit if purges go unseen.

Kept from before, not addressed here: a member hidden by a spam vote can still
sign in and reactivate themselves, which takes them out of the purge queue.
That is true of staff votes today.

## Bot side (grittybot repo, separate plan after this ships)

A small command, `bin/member-vote`, the bot's only way to vote or purge:

```
bin/member-vote show <slug>                       # roster row + votes, JSON
bin/member-vote <slug> spam|not-spam --reason "…" [--flag <tag>]… [--dry-run]
bin/member-vote <slug> clear                      # DELETE its own vote
bin/member-vote <slug> purge --evidence <path or url>… --reason "…" [--flag <tag>]… [--dry-run]
bin/member-vote staged                            # its staged votes and purge dates
bin/member-vote purges [--since <date>]           # its purge log
```

- **`purge`** requires at least one `--evidence` (a data-repo path such as
  `people/<slug>.toml#bio` or `project-updates/<project>/<n>.toml`, or the
  site URL of the record, which the command maps to one) and `--reason` (the
  command refuses a reason with a URL before calling the API). `--dry-run`
  sends `dryRun: true` and prints what would go.
- **Credential:** `~/.config/grittybot/cfp-agent-token`, mode 0600, beside the
  Slack app token, never in the repo, read by the command only; the site base
  URL in `opsbot.json` (`site.base_url`). The operator mints the grant and
  places the file; the bot never sees a person's credential and holds no
  site session.
- **Output:** the API's result plus the purge date or purge record, one JSON
  line appended to the cycle log; a refusal (409/422/429) is reported as
  such, never retried around.
- **Visibility:** every vote **and every purge** it makes is posted to
  `#grittybot-hq` in the same cycle (member slug, verdict or purge, reason,
  evidence paths, purge date or commit link, roster or purge-log link); once
  a day, a list of its staged votes that purge within 24 hours.
- **Decision rule (loop policy, in the bot's specs), in the operator's
  words:** "When someone actually posts spam, purge immediately. For signups
  that are obviously spam but haven't posted anything spammy, log a spam vote
  to put them in the 3-day purge queue pending doing anything that makes them
  not look like spam." From the `30-data-commits` stream's `new-member` and
  `profile-edit` items:
  - **Purge** when the member has posted spam: a bio (or a project, update,
    buzz item or role they authored) that promotes a business, product or
    site unrelated to civic tech, typically with a link, and it is that
    record the bot cites. If the API refuses (too old, shared project, Slack,
    a human vote), it votes `spam` instead when allowed and flags the member
    to the operators.
  - **Vote `spam`** when nothing spammy is posted but at least two
    independent signals agree and none contradicts: a business or site name
    as the member name; a GitHub account hours old (`author-account-<n>h-old`)
    or the roster's `github-new-account` / `github-no-activity`; a throwaway
    `emailDomain`; `slug-purged-before`.
  - **Never** vote or purge anyone it is talking to, anyone a maintainer added
    to a project (the membership commit's author is not the member), or
    anyone with a project footprint shared with other people; those it flags
    to the operators.
  - **Clear its vote (or vote `not-spam`)** at once when a member it staged
    stops looking like spam. What counts: a staff `not-spam` (the site already
    overrules; the bot just stops tracking); a maintainer adding them to a
    project or making them a maintainer; a real profile — a bio that
    describes a person and their interests, with no promotional link; a
    non-promotional update or comment on a project with other members; a
    Slack sign-in; a reply to the bot or an operator. What does not count on
    its own: a self-join to a project, an RSVP, an avatar, or a renamed
    account that still reads as a business. `not-spam` when it has positive
    evidence; `clear` when the signal is only that the spam case no longer
    holds.
- **Rules change in the bot repo:** the bot's own rule card makes every delete
  wait for an operator's gate word, given in the operator's own words for
  that one action. A staged vote is not a delete (the site's three days and
  human overrule are the gate), but a purge is. A standing authorization for
  posted-spam purges under this policy is a change to the bot's rules, being
  proposed separately as a reviewed PR to the bot's protocols; a person
  merges it. Until it merges, the bot votes `spam` on posted-spam accounts
  (which hides the spam at once) and asks the operator, even if its grant
  carries the purge scope.

## Rollout

1. Data repo: `agent-grants` and `spam-purges` sheet configs on every branch.
2. Release + deploy (sandbox first; sandbox shares `published` but does not
   sweep).
3. An administrator creates the agent account on production with a bio
   saying it is an AI run by Code for Philly, mints a
   `moderation:read, moderation:vote` grant (90 days), and places the token
   on the bot's host.
4. The bot ships `bin/member-vote` (vote verbs) and its policy; first week, it
   posts every vote and the operator reviews the lot.
5. Once the purge log is live in production and the bot's rules change is
   merged, an administrator mints a
   `moderation:read, moderation:vote, moderation:purge` grant (90 days),
   revokes the read + vote one, and replaces the token file. The bot turns on
   the `purge` verb; first week, the operator reviews every purge in the log.

## Notes

## Follow-ups
