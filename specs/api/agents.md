# Agents API

An **agent** is an automated moderator: a program, not a person, that staff
let act on the [admin members roster](../screens/admin-members.md). It has its
own site account and reaches the API with a **grant**: a bearer token an
administrator mints for it, scoped to moderation and nothing else. It can do
two things, each under its own scope:

- **Vote** `spam` / `not spam` on a member who only *looks* like spam. Its
  votes are labeled as an agent's in the data and on the roster, they **stage**
  (see [person-lifecycle.md → Scheduled spam purge](../behaviors/person-lifecycle.md#scheduled-spam-purge)),
  and any staff vote overrules them.
- **Purge** a new member who has *posted* spam, at once, naming the record
  that is the spam and why
  ([moderation.md → Agent purges](moderation.md#agent-purges)). The site checks
  the evidence and a set of preconditions; it does not judge the content.

Those are the operator's two cases: "When someone actually posts spam, purge
immediately. For signups that are obviously spam but haven't posted anything
spammy, log a spam vote to put them in the 3-day purge queue pending doing
anything that makes them not look like spam."

The first agent is Code for Philly's ops bot. The site does not care what runs
behind a grant; it cares that the grant is narrow, attributable and revocable.

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/admin/agents` | staff | Every agent account, its grants, and its recent purges. |
| `POST` | `/api/admin/agents` | administrator | Create an agent account and its first grant. |
| `POST` | `/api/admin/agents/:slug/grants` | administrator | Mint a grant; the token is returned once. |
| `POST` | `/api/admin/agents/:slug/grants/:id/revoke` | administrator | Revoke a grant at once, and optionally withdraw the agent's staged votes. |
| `POST` | `/api/admin/agents/:slug/withdraw-votes` | staff | Withdraw every vote the agent has staged, in one commit. |

Anyone else gets `404 not_found`, like the rest of `/api/admin`. The
moderation endpoints an agent calls with its token are in
[moderation.md](moderation.md).

## The agent account

An agent account is a `people` record created by an administrator here, never
by GitHub sign-in:

- `accountLevel = user`, no `githubUserId`, no legacy password, and no
  private profile (a private profile holds an email, and an agent has none). **It cannot sign in to the site or to Slack**: there
  is no identity for OAuth, a password or SAML to bind to. The only way in is a
  grant.
- It is public like any member (`/members/<slug>`), and its `bio` says what it
  is and who runs it. It is an agent because the `agent-grants` sheet holds a
  grant for it, active or not; nothing else marks it. A revoke or an expiry
  only ends a grant, never deletes its record (only purging the agent account
  itself does), and an agent is created with its first grant, so an agent
  whose every grant has been revoked or has expired is still an agent account,
  under every rule below.
- It can never be raised to staff: `POST /api/people/:slug/account-level`
  refuses (`409 conflict`, `error.code = "agent_account"`) for a person with
  any grant on record. Agents are never staff, so an agent's vote and a human's
  vote can never come from the same account.
- Moderation treats it as off limits: nobody votes on it
  (`422`, `slug: agent`), no agent purges it, and the [scheduled spam
  purge](../behaviors/person-lifecycle.md#scheduled-spam-purge) never takes it.
  To stop an agent, revoke its grants.
- Its slug is fixed: `PATCH /api/people/:slug` refuses to rename it (`409
  conflict`, `error.code = "agent_account"`). Its votes are recorded as
  `agent-<slug>` and its purges as `by = "agent-<slug>"`; a rename would not
  follow those, and would reset the daily allowances counted from them.
- No GitHub sign-in can take it over: account matching never offers it as a
  candidate, a post-sign-up search does not find it, and staff approval of a
  claim request naming it is refused (`409 conflict`, `error.code =
  "agent_account"`)
  ([account-migration.md](../behaviors/account-migration.md#matching-algorithm-at-oauth-callback)).

## Grants

A grant is one bearer token for one agent account, with a fixed list of scopes
and a hard expiry.

| Scope | Allows |
| ----- | ------ |
| `moderation:read` | `GET /api/admin/members` and `GET /api/admin/members/:slug`, with the redactions in [moderation.md → Agent callers](moderation.md#agent-callers). |
| `moderation:vote` | `POST /api/admin/members/:slug/vote` and `DELETE /api/admin/members/:slug/vote`, within the [agent vote rules](moderation.md#agent-votes). |
| `moderation:purge` | `POST /api/admin/members/:slug/purge`, within the [agent purge rules](moderation.md#agent-purges). |

There are no other scopes. A grant does not make its holder `user`, `self` or
`staff` anywhere else ([authorization.md → Agent grants](../behaviors/authorization.md#agent-grants)).

`moderation:purge` is its own scope, not implied by `moderation:vote`, so an
administrator can let an agent stage votes without letting it delete anything.
A grant with `moderation:purge` must also carry `moderation:read` (`422`
otherwise): an agent that cannot read the roster cannot check what it is about
to delete. Scopes are fixed for a grant's life; adding purge to an agent is a
new grant and a revoke of the old one, so the change is its own public
`agent.grant` commit.

- **Token:** `cfpa_` followed by 32 random bytes, base64url. Shown once, in the
  mint response. The site keeps only its SHA-256 hash, in the private store
  ([private-storage.md](../behaviors/private-storage.md)); the public
  `agent-grants` record says that the grant exists, for whom, with which
  scopes, by whom and until when — never the token or its hash.
- **Presented as** `Authorization: Bearer cfpa_…` on each request. No cookie,
  so no CSRF surface. Never logged; never written to a commit.
- **Expiry:** `expiresInDays` 1–180, default 90. An expired grant is refused
  like a revoked one. Renewal is a new grant and a revoke of the old one.
- **Revocation** is immediate: the in-memory grant table is updated in the same
  request. An agent's staged votes count toward a purge only while it holds
  an active grant
  ([person-lifecycle.md](../behaviors/person-lifecycle.md#scheduled-spam-purge)):
  once its last active grant is revoked (or expires) they stop counting, and
  they stay on the record. **If a new grant is minted for the agent later, they
  count again**, from the moment of the mint, unless they were withdrawn. So a
  revoke for a compromised token passes `withdrawVotes: true`, which withdraws
  them in the same commit; a routine rotation (mint the new grant, then revoke
  the old one) does not, and the votes count throughout.
  Revoking does not undo purges already made; those are restored one by one
  ([person-lifecycle.md → Restoring a purged member](../behaviors/person-lifecycle.md#restoring-a-purged-member)).
- **Last used:** the API records `lastUsedAt` on the private record, at most
  once an hour per grant.

## GET /api/admin/agents

```json
{
  "success": true,
  "data": [
    {
      "person": { "slug": "example-bot", "fullName": "Example Bot", "deletedAt": null },
      "grants": [
        { "id": "…", "label": "ops bot, host vm-1", "scopes": ["moderation:read", "moderation:vote"],
          "createdAt": "…", "createdBy": { "slug": "jane", "fullName": "Jane Doe" },
          "expiresAt": "…", "revokedAt": null, "lastUsedAt": "…", "active": true }
      ],
      "stagedVotes": { "spam": 3, "legit": 1 },
      "purges": { "last24h": 1, "last30d": 4 }
    }
  ]
}
```

`stagedVotes` counts the agent's votes on people no human has voted on.
`purges` counts the agent's `spam-purges` records; the records themselves, with
reason and evidence, are `GET /api/admin/spam-purges?by=agent-<slug>`
([moderation.md](moderation.md#get-apiadminspam-purges)).

Staff, not only administrators, may list agents: the panel that shows what an
agent staged and purged is a staff review surface, and nothing here is secret
(grants are public records; tokens are never returned after mint).

## POST /api/admin/agents

```json
{
  "slug": "example-bot",
  "fullName": "Example Bot",
  "bio": "An AI ops bot run by … Its spam votes on /admin/members are staged and staff overrule them; it purges only accounts that posted spam, and says why.",
  "grant": { "label": "ops bot, host vm-1", "scopes": ["moderation:read", "moderation:vote"], "expiresInDays": 90 }
}
```

`bio` is required (an agent says what it is), and so is `grant`: an account
is an agent because it holds a grant, so an account created without one would
be an ordinary member with no sign-in. Creates the person and the grant (its
token hash in the private store) in one transaction; the slug follows
[slug-handles.md](../behaviors/slug-handles.md), including the rule that a
slug with moderation history is not reused
([slug-handles.md](../behaviors/slug-handles.md#moderation-history-retires-a-slug)).

Response `201`: `{ person, grant, token }` — `token` only in this response.

## POST /api/admin/agents/:slug/grants

`{ "label", "scopes", "expiresInDays" }` → `201 { grant, token }`. `404` when
`slug` is not an agent account (a member cannot be turned into an agent: create
the agent instead).

## POST /api/admin/agents/:slug/grants/:id/revoke

```json
{ "withdrawVotes": true }
```

The body is optional. Sets `revokedAt = now()`. `200 { grant }`. Revoking a
revoked grant without `withdrawVotes` is a no-op (no commit).

`withdrawVotes: true` is for a token that may be compromised: in the same
transaction and commit as the revoke, it withdraws every vote the agent has
staged, exactly as [withdraw-votes](#post-apiadminagentsslugwithdraw-votes)
does with no `since` (the agent's votes on people no human has voted on;
the members its votes hid are reactivated). The response adds `{ withdrawn,
reactivated }`. On a grant already revoked it still withdraws (the compromise
may be found after the revoke). The commit carries `Withdraw-Votes: true`.

## POST /api/admin/agents/:slug/withdraw-votes

The undo for an agent that has gone wrong. Staff, not only administrators:
anyone who can overrule a vote one at a time can overrule them all.

```json
{ "since": "2026-11-01T00:00:00Z" }
```

`since` is optional. Deletes every `agent-<slug>` evaluation (newer than
`since`) on a person with **no human vote**, and reactivates each such person
whose deactivation that agent's vote caused (the [reversal
rule](../behaviors/person-lifecycle.md#deactivate-soft-self-service)). Votes on
people a human has since voted on are left as the record, and so are votes on
people who no longer exist (purged: their votes are the record of why). One
commit.

Response `200`: `{ "withdrawn": 7, "reactivated": 5 }`. Withdrawing does not
revoke the grant; when the token itself is in doubt, revoke with
`withdrawVotes: true`, which does both in one commit. Withdrawing does
not touch the agent's purges: there is no bulk undo for a delete. Each is
restored on its own
([person-lifecycle.md → Restoring a purged member](../behaviors/person-lifecycle.md#restoring-a-purged-member)),
and the purge log names every one ([moderation.md](moderation.md#get-apiadminspam-purges)).

## Commits

Every write here is a commit on the data repo through the write mutex, by the
calling administrator or staff member, with `Action: agent.create`,
`agent.grant`, `agent.revoke` or `agent.withdraw-votes`, `Subject-Type: person`,
`Subject-Slug: <agent slug>`, and `Grant-Id: <id>` where one grant is
concerned. Agent grants are a change of access, so they are in the public audit
log the same way an account-level change is. (An agent's own votes and purges
are committed as the agent: [moderation.md](moderation.md#agent-votes).)

## Errors

- `422 validation_failed` — unknown scope, `moderation:purge` without
  `moderation:read`, `expiresInDays` out of range, missing `bio` or `grant`,
  bad or taken slug, or a slug with moderation history (`slug_retired`)
- `404 not_found` — not an administrator (staff for `GET` and
  `withdraw-votes`), or no such agent or grant
