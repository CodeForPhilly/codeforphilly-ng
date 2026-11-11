# Moderation API

Staff-facing endpoints behind the [admin members screen](../screens/admin-members.md):
a newest-first roster of members with their footprint on the site, and a way to
record a **human spam verdict** that the offline spam pipeline treats as final
(see [behaviors/spam-exclusion.md](../behaviors/spam-exclusion.md)). An
[agent](agents.md) holding a grant may read the roster and cast **staged**
votes that any human vote overrules ([Agent votes](#agent-votes)).

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
  followers). Informational: `slack-sso`, `has-footprint`.

`purgeAfter` is when the [scheduled spam purge](../behaviors/person-lifecycle.md#scheduled-spam-purge) will take the member — three days after the newest **deciding** vote, when every deciding vote is `spam` and the member is still deactivated and not staff — or `null`. The deciding votes are the human votes; when there are none, the votes of agents that still hold an active grant.

None of it is reachable by a non-staff caller (who gets 404 anyway). `latestVote` is `null`
when no human has voted; it never holds an agent's vote.

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
    ]
  }
}
```

`votes` is newest first, human and agent votes together; `kind` tells them
apart (from the `evaluator` prefix — [spam-exclusion.md](../behaviors/spam-exclusion.md#where-verdicts-come-from)). Everything in `footprint` is drawn from the in-memory
public state — nothing here is fetched from elsewhere.

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
   on: `409 human_verdict_exists`. Its earlier vote on that member stays as the
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
