# Moderation API

Staff-facing endpoints behind the [admin members screen](../screens/admin-members.md):
a newest-first roster of members with their footprint on the site, and a way to
record a **human spam verdict** that the offline spam pipeline treats as final
(see [behaviors/spam-exclusion.md](../behaviors/spam-exclusion.md)). An
[agent](agents.md) holding a grant may read the roster, cast **staged** votes
that any human vote overrules ([Agent votes](#agent-votes)) on members who only
look like spam, and **purge** a new member who has posted spam
([Agent purges](#agent-purges)). Every spam purge, by anyone, leaves a public
[`spam-purges`](../data-model.md#spampurge) record that stops the same GitHub
account signing up again until staff unblock it.

All endpoints require `accountLevel ∈ {staff, administrator}`, or an agent
grant with the scope named below (`agent:<scope>` in
[authorization.md](../behaviors/authorization.md#agent-grants)). Anyone else
gets `404 not_found` — like the other staff surfaces, the endpoints' existence
is not a signal.

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/admin/members` | `staff \| agent:moderation:read` | Paginated roster, newest signup first, with vote state and footprint counts. |
| `GET` | `/api/admin/members/:slug` | `staff \| agent:moderation:read` | One member's full footprint plus every vote on record. |
| `POST` | `/api/admin/members/:slug/vote` | `staff \| agent:moderation:vote` | Record the caller's verdict; applies the side effect described below. |
| `DELETE` | `/api/admin/members/:slug/vote` | `agent:moderation:vote` | Withdraw the calling agent's own vote. |
| `POST` | `/api/admin/members/:slug/purge` | `agent:moderation:purge` | Purge a new member who posted spam, citing the evidence. |
| `GET` | `/api/admin/spam-purges` | `staff \| agent:moderation:read` | The spam-purge log, newest first. |
| `POST` | `/api/admin/spam-purges/:id/unblock` | `staff` | Let the purged GitHub account sign up again. |

Staff purge a member from the person's Danger Zone
([api/people.md → purge](people.md#post-apipeopleslugpurge), administrators
only); this file holds only the agent's purge.

## Votes belong to one account

`person-evaluations` records are keyed by slug, and a purge leaves them in
place as the record of why. A later sign-up can get the same slug (a GitHub
sign-up takes its slug from the GitHub login, and the purge freed it). A vote
whose `evaluatedAt` is **earlier than the person's `createdAt`** was cast on
that earlier account, and every rule in this file and in
[person-lifecycle.md](../behaviors/person-lifecycle.md) ignores it: it is not
the `latestVote` or `stagedVote`, it does not decide, it does not set
`purgeAfter`, it does not trip `human_verdict_exists`, and the reversal rule
does not see it. The detail response lists such votes apart, as
`earlierVotes`, and the row carries the `slug-purged-before` signal.

(Before this rule the earlier account's votes attached to the new one: a
re-registration showed the old staff vote as its own, an agent could not act
on it, and a self-deactivation would have put it straight into the sweep on a
vote nobody had cast on it.)

## GET /api/admin/members

### Query parameters

| Param | Type | Notes |
| ----- | ---- | ----- |
| `q` | string | Substring match on `fullName`, `slug`, `bio`, and (staff-visible) `email` — searched for every query, so `.com` finds every member on that domain. For an agent caller, only the email's domain is searched. Applies to the whole roster, then paginates. |
| `vote` | enum | `none` (no human vote yet — includes agent-staged rows) \| `staged` (no human vote, and an agent vote) \| `spam` \| `legit`. `spam` and `legit` filter on the **latest** human vote. |
| `origin` | enum | `imported` (has a laddr `legacyId`) \| `signed-up` (created on this site through GitHub). |
| `joinedAfter`, `joinedBefore` | ISO date | Inclusive bounds on `createdAt`. |
| `includeDeactivated` | bool | Default `true` — moderation needs to see what it hid. |
| `sort` | sort | Default `-createdAt`. Allowed: `createdAt`, `fullName`, `lastLoginAt`. |
| `page`, `perPage` | int | Default `perPage = 50`, max 200. |

### Response — 200

```json
{
  "success": true,
  "data": [
    {
      "id": "…", "slug": "jane", "fullName": "Jane Doe", "avatarUrl": "…",
      "createdAt": "2026-09-17T22:41:00Z",
      "deletedAt": null,
      "origin": "signed-up",
      "email": "jane@example.org",
      "emailDomain": "example.org",
      "hasGitHubLink": true,
      "github": { "login": "janedoe", "accountCreatedAt": "2019-03-02T…", "publicRepos": 12, "followers": 40, "status": "ok", "checkedAt": "…" },
      "lastLoginAt": "2026-09-18T01:12:00Z",
      "signInCount": 4,
      "lastSlackSsoAt": "2026-09-18T01:15:00Z",
      "emailBounce": null,
      "bioExcerpt": "first ~160 chars of bio, markdown stripped",
      "footprint": { "memberships": 2, "updates": 1, "buzz": 0, "blogPosts": 0, "helpWantedInterest": 1, "tags": 3 },
      "latestVote": { "verdict": "legit", "voter": { "slug": "chris", "fullName": "Chris Alfano" }, "evaluatedAt": "…" },
      "stagedVote": null,
      "purgeAfter": null,
      "signals": ["slack-sso", "has-footprint"],
      "attention": 0
    }
  ],
  "metadata": { "timestamp": "…", "page": 1, "perPage": 50, "totalItems": 12661, "totalPages": 254 }
}
```

Field notes:

- `origin` — `imported` when the record carries a laddr `legacyId`, else
  `signed-up` (every new-site account arrives through GitHub OAuth).
- `email`, `github`, `lastSlackSsoAt`, `emailBounce` come from the private
  profile ([behaviors/private-storage.md](../behaviors/private-storage.md)).
  `github` is present whenever the person is GitHub-linked; `status` is `ok`,
  `gone` (GitHub 404s the account — deleted or suspended), or `unknown` (never
  probed). Rows on the requested page are re-probed when their record is older
  than a day, with bounded concurrency; a failed probe keeps the old record.
- `lastLoginAt` / `signInCount` come from session metadata (sessions issued to
  the person).
- `signals` are **row-local** facts, never machine verdicts. Negative ones
  count toward `attention`: `never-signed-in`, `no-avatar`, `no-bio`,
  `bio-links:<n>`, `email-name-mismatch` (email local-part shares no ≥3-letter
  token with the display name), `email-bounced:<type>`, `github-gone`,
  `github-new-account` (< 30 days), `github-no-activity` (0 repos and 0
  followers), `slug-purged-before` (a [`spam-purges`](../data-model.md#spampurge)
  record names this slug: an earlier account under it was purged as spam).
  Informational: `slack-sso`, `has-footprint`.

`purgeAfter` is when the [scheduled spam purge](../behaviors/person-lifecycle.md#scheduled-spam-purge) will take the member — three days after the newest **deciding** vote, when every deciding vote is `spam` and the member is still deactivated and not staff — or `null`. The deciding votes are the human votes; when there are none, the votes of agents that still hold an active grant.

None of it is reachable by a non-staff caller (who gets 404 anyway). `latestVote` is `null`
when no human has voted; it never holds an agent's vote. Every vote field here
counts only votes on this account ([Votes belong to one account](#votes-belong-to-one-account)).

`stagedVote` is the newest agent vote when **no human has voted** on the
member, else `null`:

```json
"stagedVote": {
  "verdict": "spam",
  "agent": { "slug": "example-bot", "fullName": "Example Bot" },
  "reasoning": "Business name; GitHub account 3h old; promotional link added to bio 6 min after sign-up.",
  "flags": ["business-name", "github-new-account", "bio-added-link"],
  "evaluatedAt": "…",
  "counts": true
}
```

`counts` is `false` when the agent no longer holds an active grant: the vote
stays on the row as a record but no longer queues a purge.

`emailDomain` is the part of `email` after the `@`, or `null`.

## GET /api/admin/members/:slug

The row above, plus the full footprint and vote history:

```json
{
  "success": true,
  "data": {
    "person": { …Person as GET /api/people/:slug for staff, including email and deletedAt… },
    "footprint": {
      "memberships": [ { "project": { "slug", "title" }, "role", "joinedAt" } ],
      "updates":     [ { "project": { "slug", "title" }, "number", "title", "postedAt" } ],
      "buzz":        [ { "project": { "slug", "title" }, "slug", "title", "postedAt" } ],
      "blogPosts":   [ { "slug", "title", "postedAt" } ],
      "helpWantedInterest": [ { "project": { "slug", "title" }, "role": { "title" }, "createdAt" } ],
      "tags":        [ { "handle", "type" } ]
    },
    "votes": [
      { "kind": "human", "verdict": "spam", "reasoning": "…", "flags": ["manual-override"], "voter": { "slug", "fullName" }, "evaluatedAt": "…" },
      { "kind": "agent", "verdict": "spam", "reasoning": "…", "flags": ["github-new-account"], "voter": { "slug", "fullName" }, "evaluatedAt": "…" }
    ],
    "earlierVotes": [],
    "earlierPurges": [ { "id": "…", "purgedAt": "…", "by": "human-jane", "reason": "…" } ]
  }
}
```

`votes` is newest first, human and agent votes together; `kind` tells them
apart (from the `evaluator` prefix — [spam-exclusion.md](../behaviors/spam-exclusion.md#where-verdicts-come-from)).
`earlierVotes` (same shape) are votes on an earlier account under this slug,
and `earlierPurges` the [`spam-purges`](../data-model.md#spampurge) records for
this slug ([Votes belong to one account](#votes-belong-to-one-account)).
Everything here is drawn from the in-memory public state — nothing is fetched
from elsewhere.

### Errors

- `404 not_found` — slug doesn't exist, or the caller is not staff

## POST /api/admin/members/:slug/vote

Record the caller's verdict on this person as a `person-evaluations` record with
`evaluator = "human-<callerSlug>"` — or `"agent-<agentSlug>"` when the caller is
an agent (one record per voter per person — voting again replaces the caller's
previous record). Committed through the write mutex as the caller, so the vote
carries the voter's pseudonymous git identity.

### Request

```json
{ "verdict": "spam" | "legit", "reasoning": "optional, ≤ 1000 chars" }
```

An agent also sends `flags` (0–10 short reason tags, each
`^[a-z0-9][a-z0-9:-]{0,39}$`), and `reasoning` is **required** for it (1–1000
chars): a person reviewing the staged vote reads it. Human votes carry
`flags = ["manual-override"]` and `confidence = 1`; agent votes carry
`["agent", …flags]` and no `confidence`.

### Side effects (per [behaviors/person-lifecycle.md](../behaviors/person-lifecycle.md))

- `verdict = "spam"` → the person is **deactivated** in the same transaction
  (`deletedAt = now()` if not already set).
- `verdict = "legit"` → if the person's previous **latest** vote, human or
  agent, was `spam` (i.e. this vote reverses a moderation hide — a staff
  member's or an agent's), `deletedAt` is cleared. A self-deactivation is left
  alone.
- A human vote on a member an agent had staged is an ordinary human vote: from
  then on the human votes decide and the agent's record is only history. That
  is how staff **overrule** (`legit`) or **confirm** (`spam`) a staged vote.
- Voting on yourself, or on an agent account, is rejected.

### Response — 200

```json
{ "success": true, "data": { "person": Person, "vote": { …the recorded vote… }, "latestVote": { … } } }
```

### Errors

- `422 validation_failed` — bad verdict, reasoning too long or (agent) missing,
  bad flags, `slug` is the caller, or `slug` is an agent account
- `409 conflict` — (agent) `error.code = "human_verdict_exists"`, `"member_too_old"`
  or `"protected_account"`; see [Agent votes](#agent-votes)
- `429 rate_limited` — (agent) over its daily spam-vote allowance
- `404 not_found` — slug doesn't exist, or the caller is not staff and holds no
  grant with the scope

## DELETE /api/admin/members/:slug/vote

Agent only. Deletes the calling agent's own `agent-<agentSlug>` record on this
person, so an agent can take back a ruling as freely as it made one. If that
was the person's latest vote and it was `spam`, and no other agent's `spam`
vote remains, the person is reactivated (the reversal rule). Response `200 { person, stagedVote }`;
`404` when the agent has no vote on the person. Staff change a vote by voting
again; clearing a human vote is not offered.

This is how the "pending doing anything that makes them not look like spam"
half of the policy works: when a member the agent staged does something that
makes them look legitimate, the agent clears its vote (back to unvoted, in the
default review view) or votes `legit` (when it has positive evidence). What
counts is the agent's judgment, listed in the bot's own policy; the site only
records it. Once a human has voted on the member the agent's vote is history
and stays: `DELETE` answers `409 human_verdict_exists`, as `withdraw-votes`
leaves it ([agents.md](agents.md#post-apiadminagentsslugwithdraw-votes)).

## Agent callers

A request carrying an agent grant (`Authorization: Bearer cfpa_…`) sees the
roster as staff do, less what an agent does not need:

- `email` is always `null`; `emailDomain` is kept (a throwaway domain is a
  spam signal; the address is not). `person` in the detail response omits
  `email` too.
- `q` matches `fullName`, `slug`, `bio` and the email **domain** only.
- Rows and the GitHub re-probe are the same as for staff; the probe is
  bounded the same way.

## Agent votes

An agent's vote is a **staged** ruling: it acts at once (a `spam` vote hides
the member), it is labeled as an agent's everywhere, and it purges after three
days only if no human has voted in the meantime. The rules, checked inside the
write mutex:

1. **Humans are final.** An agent may not vote on a member any human has voted
   on (on this account: [Votes belong to one account](#votes-belong-to-one-account)):
   `409 human_verdict_exists`. Its earlier vote on that member stays as the
   record and has no effect.
2. **Only ordinary members.** The member must be `accountLevel = user` and not
   an agent account: `409 protected_account` / `422`.
3. **Only new members, for `spam`.** A `spam` vote needs the member's
   `createdAt` within the last **30 days**: `409 member_too_old`. Long-standing
   members are a human's call. `legit` votes have no age limit.
4. **Volume.** At most **20** `spam` votes per agent in any rolling 24 hours,
   counted from the agent's own records' `evaluatedAt` (a re-vote counts again):
   `429 rate_limited` with `Retry-After`. The general per-account write cap in
   [conventions.md](conventions.md#rate-limiting) applies on top.
5. **Attribution.** The commit is authored by the agent account
   (`<agent fullName> <<agentSlug>@users.noreply.codeforphilly.org>`), subject
   `<agentSlug>: POST /api/admin/members/<slug>/vote` (or `DELETE`), with the
   usual trailers plus `Actor-Kind: agent` and `Grant-Id: <grant id>`
   ([storage.md → Commit message shape](../behaviors/storage.md#commit-message-shape)).
   `Actor-Account-Level` is `user`.

A staged vote is the right tool when the member has **not posted** anything
spammy: a business or site name as the member name, a throwaway GitHub
account. When the member has posted spam, the agent purges instead
([Agent purges](#agent-purges)); if it holds no purge scope it votes `spam`
(which hides the spam at once) and leaves the purge to staff.

## POST /api/admin/members/:slug/purge

Agent only (`agent:moderation:purge`). Purges a member **who has posted spam**
— the account itself put spam content on the site — at once, without the
three-day wait. The agent names the record that is the spam and says why; the
site verifies the record is the member's and that the
[agent purge rules](#agent-purges) hold, then runs the same cascade as an
administrator's purge
([person-lifecycle.md → Purge](../behaviors/person-lifecycle.md#purge-cascading-hard-delete-admin-only)).

### Request

```json
{
  "reason": "Signed up under a business name; 90 s later set a bio advertising that business, with a link.",
  "flags": ["bio-promo-link", "business-name", "github-new-account"],
  "evidence": [
    { "record": "person", "field": "bio" }
  ],
  "dryRun": false
}
```

- `reason` — required, 1–1000 chars, and **no URL** (`422`, `reason`: a purge
  must not republish the spam link in a permanent public commit; cite the
  record instead).
- `flags` — 0–10 tags, as on a vote.
- `evidence` — 1–5 items, each naming one record **the member authored** and,
  where the record has several text fields, which one:

  | `record` | Identified by | The member's when | `field` |
  | -------- | ------------- | ----------------- | ------- |
  | `person` | (the member) | always | `bio` (required) |
  | `project` | `project` (slug) | `createdById` is the member | `title` \| `summary` \| `overview` (optional) |
  | `project-update` | `project`, `number` | `authorId` is the member | — |
  | `project-buzz` | `project`, `slug` | `postedById` is the member | — |
  | `help-wanted-role` | `project`, `roleId` | `postedById` is the member | — |

  The site checks that each record exists, is the member's, and that the cited
  field (or the record's body) is not empty; otherwise `422 evidence_invalid`
  naming the item. It does not judge whether the content is spam: that is the
  agent's call, and the reason and evidence make it reviewable. The member's
  *name* is not evidence of posting: a business name with nothing posted is a
  vote, not a purge.
- `dryRun` — run every check and return what would be deleted; write nothing.

### Response — 200

```json
{
  "success": true,
  "data": {
    "purge": { …the spam-purges record… },
    "deleted": { "projects": [ { "slug": "…", "title": "…" } ], "memberships": 1, "updates": 0, "buzz": 0, "helpWantedRoles": 0, "rsvps": 0 },
    "dryRun": false
  }
}
```

### Errors

- `422 validation_failed` — missing or URL-bearing `reason`, bad flags, no
  evidence or more than 5, `slug` is the caller or an agent account
- `422 evidence_invalid` — an evidence record missing, not the member's, or
  empty
- `409 conflict` — `error.code` one of `human_verdict_exists`,
  `legit_vote_exists`, `member_too_old`, `protected_account`,
  `established_member`, `shared_project`, `evidence_survives`; see
  [Agent purges](#agent-purges)
- `429 rate_limited` — over the daily purge allowance, with `Retry-After`
- `404 not_found` — slug doesn't exist, or no grant with the scope

## Agent purges

An agent purge is **immediate**: no staging, no three days. That is the
operator's policy for an account that has posted spam ("purge immediately"),
and the reason it is fenced harder than a vote. The rules, checked inside the
write mutex, in this order:

1. **Only ordinary, signed-up members.** `accountLevel = user`, not an agent
   account, no laddr `legacyId`: `409 protected_account` / `422`.
2. **Only brand-new members.** `createdAt` within the last **7 days**:
   `409 member_too_old`. Posted spam comes within minutes of sign-up (both
   cases this was designed against posted within two minutes); seven days
   covers a slow weekend. Anything older is a staged vote at most (30 days),
   and past that a human's call.
3. **Humans are final.** Any human vote on this account, `spam` or `legit`,
   blocks: `409 human_verdict_exists`. A staff `legit` always wins; a staff
   `spam` has already hidden the member and put them on the clock, and the
   agent does not shorten a person's clock.
4. **No `legit` vote standing.** Any agent's `legit` vote on this account
   (its own included) blocks: `409 legit_vote_exists`. An agent that changes
   its mind clears its `legit` first, so the record shows it did.
5. **Not established.** A member who has signed into Slack through the site
   (`lastSlackSsoAt` set) is past the point an agent decides alone:
   `409 established_member`.
6. **Nothing shared.** The member must not have created a project anyone else
   has touched (the rule in
   [person-lifecycle.md → Purge](../behaviors/person-lifecycle.md#purge-cascading-hard-delete-admin-only)),
   and must not be a maintainer of any project with another member:
   `409 shared_project`. A purge must never take a project or leave one
   without its maintainer on an agent's say-so.
   **Being a plain member of someone else's project does not block.** Joining
   is self-service (`POST /api/projects/:slug/members/join`, any signed-in
   user, no maintainer acceptance), so it carries no one else's judgment, and
   spam accounts join real projects to borrow their credibility. The purge
   removes the member's own membership and anything they posted there; the
   project and everyone else's records are untouched. (A membership a
   maintainer *added* would be different, but the membership record does not
   say who added it; the agent's own policy treats a maintainer-added
   membership as a reason not to act — see the plan.)
7. **The evidence goes with the purge.** Every evidence record must be one the
   purge deletes (the member's own record, a project the purge takes, or an
   update, buzz item or role they authored that goes with them):
   `409 evidence_survives`. The agent may not cite content it is not removing.
8. **Volume.** At most **5** purges per agent in any rolling 24 hours, counted
   from its `spam-purges` records: `429 rate_limited` with `Retry-After`.
   Separate from, and lower than, the 20 spam votes.

When every rule holds, in one transaction and **one commit per purge** (never
batched, so it reverts on its own):

- the cascade in
  [person-lifecycle.md → Purge](../behaviors/person-lifecycle.md#purge-cascading-hard-delete-admin-only),
  public and private, including avatars and other attachments of deleted
  records;
- the agent's `person-evaluations` record on the slug is written (or replaced)
  as `verdict = "spam"`, `flags = ["agent", "purged", …flags]`, `reasoning =
  reason` — the vote is the durable "why" the way a staff vote is;
- a [`spam-purges`](../data-model.md#spampurge) record with `by =
  "agent-<agentSlug>"`, the grant id, the reason, flags and evidence (each with
  its data-repo path), the commit the purge was applied on, and
  `blocksSignIn = true`.

The commit is authored by the agent account, subject
`<agentSlug>: POST /api/admin/members/<slug>/purge`, body the `reason`, and
trailers `Action: person.purge`, `Subject-Type: person`, `Subject-Id`,
`Subject-Slug`, `Actor-Kind: agent`, `Grant-Id`, `Purge-Id: <spam-purges id>`,
and one `Evidence: <path>[#<field>]` per item
([storage.md → Commit message shape](../behaviors/storage.md#commit-message-shape)).
`git log --grep='^Action: person.purge$' --grep='^Actor-Kind: agent$' --all-match`
lists every agent purge; `git show <commit>^:<evidence path>` shows the spam as
it stood.

A wrong purge is restored by hand
([person-lifecycle.md → Restoring a purged member](../behaviors/person-lifecycle.md#restoring-a-purged-member));
revoking the grant stops further purges at once.

## GET /api/admin/spam-purges

The spam-purge log: every [`spam-purges`](../data-model.md#spampurge) record,
newest first. A purged member has no roster row left, so this is where staff
see what was purged, by whom and why.

| Param | Type | Notes |
| ----- | ---- | ----- |
| `by` | string | `agent` \| `human` \| `scheduled`, or one evaluator (`agent-<slug>`, `human-<slug>`). |
| `slug` | string | Records for one slug. |
| `since` | ISO date | `purgedAt` on or after. |
| `blocking` | bool | Only records whose sign-in block is in force. |
| `page`, `perPage` | int | Default `perPage = 50`, max 200. |

Each item is the record plus `byRef` (its `by` resolved: `{ kind, slug,
fullName }`; `by` itself stays the stored string), each evidence item's `url`
(the record as it stood, on the data repo's GitHub at `beforeCommit`), and
`commitUrl` (the history of the record's own path, whose first entry is the
purge commit).

## POST /api/admin/spam-purges/:id/unblock

Staff. Lifts the record's sign-in block: sets `unblockedAt = now()` and
`unblockedBySlug`; the record itself stays. `{ "reason": "optional, ≤ 1000" }`.
`200 { purge }`; unblocking an unblocked record is a no-op. Committed as the
caller with `Action: spam-purge.unblock`. Used when a purge was wrong (with the
restore) or a person asks to start over.

## Relationship to other specs

- [behaviors/spam-exclusion.md](../behaviors/spam-exclusion.md) — the
  `person-evaluations` record shape, why human votes live on `published`, and
  how the offline pipeline consumes them.
- [behaviors/person-lifecycle.md](../behaviors/person-lifecycle.md) — the
  deactivate side effect and its reversal rule.
- [api/people.md](people.md) — `deactivate`, `reactivate`, `purge`, and the
  staff-only fields reused here.
- [api/agents.md](agents.md) — agent accounts, grants, and withdrawing an
  agent's staged votes.
- [api/auth.md](auth.md) — the GitHub callback refuses a GitHub account a
  `spam-purges` record blocks.

## POST /api/admin/private-data/purge-orphans

Administrator only (`404` for anyone else, like the rest of `/api/admin`).
Deletes the private data of every person id the private store knows that has
no `people` record: private profile, legacy password, password-reset tokens,
account-claim requests naming them, and session metadata — what
[Purge](../behaviors/person-lifecycle.md#purge-cascading-hard-delete-admin-only)
now deletes in its own transaction, for everyone purged or pruned before it
did.

### Request

```json
{ "apply": false }
```

`apply` is required: `false` only counts; `true` deletes and returns the same
counts. Run under the write lock, so a member mid-sign-up (private profile
written, public record not yet) is never counted.

### Response — 200

```json
{ "success": true, "data": { "applied": false, "orphanPeople": 27, "profiles": 27, "legacyPasswords": 0, "claimRequests": 0, "sessions": 0 } }
```

Counts only — never emails, names or ids. The private store is not versioned,
so `apply: true` cannot be undone; run `false` first.
