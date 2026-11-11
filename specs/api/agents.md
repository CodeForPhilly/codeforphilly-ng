# Agents API

An **agent** is an automated moderator: a program, not a person, that staff
let cast `spam` / `not spam` votes on the [admin members
roster](../screens/admin-members.md). It has its own site account and reaches
the API with a **grant**: a bearer token an administrator mints for it, scoped
to moderation and nothing else. Its votes are labeled as an agent's in the data
and on the roster, they **stage** (see
[person-lifecycle.md → Scheduled spam purge](../behaviors/person-lifecycle.md#scheduled-spam-purge)),
and any staff vote overrules them.

The first agent is Code for Philly's ops bot. The site does not care what runs
behind a grant; it cares that the grant is narrow, attributable and revocable.

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/admin/agents` | administrator | Every agent account and its grants. |
| `POST` | `/api/admin/agents` | administrator | Create an agent account (and optionally its first grant). |
| `POST` | `/api/admin/agents/:slug/grants` | administrator | Mint a grant; the token is returned once. |
| `POST` | `/api/admin/agents/:slug/grants/:id/revoke` | administrator | Revoke a grant at once. |
| `POST` | `/api/admin/agents/:slug/withdraw-votes` | staff | Withdraw every vote the agent has staged, in one commit. |

Anyone else gets `404 not_found`, like the rest of `/api/admin`. The
moderation endpoints an agent calls with its token are in
[moderation.md](moderation.md).

## The agent account

An agent account is a `people` record created by an administrator here, never
by GitHub sign-in:

- `accountLevel = user`, no `githubUserId`, no legacy password, and a private
  profile with no email. **It cannot sign in to the site or to Slack**: there
  is no identity for OAuth, a password or SAML to bind to. The only way in is a
  grant.
- It is public like any member (`/members/<slug>`), and its `bio` says what it
  is and who runs it. It is an agent because the `agent-grants` sheet holds a
  grant for it; nothing else marks it.
- It can never be raised to staff: `POST /api/people/:slug/account-level`
  refuses (`409 conflict`, `error.code = "agent_account"`) for a person with
  any grant on record. Agents are never staff, so an agent's vote and a human's
  vote can never come from the same account.
- Moderation treats it as off limits: nobody votes on it
  (`422`, `slug: agent`), and the [scheduled spam
  purge](../behaviors/person-lifecycle.md#scheduled-spam-purge) never takes it.
  To stop an agent, revoke its grants.

## Grants

A grant is one bearer token for one agent account, with a fixed list of scopes
and a hard expiry.

| Scope | Allows |
| ----- | ------ |
| `moderation:read` | `GET /api/admin/members` and `GET /api/admin/members/:slug`, with the redactions in [moderation.md → Agent callers](moderation.md#agent-callers). |
| `moderation:vote` | `POST /api/admin/members/:slug/vote` and `DELETE /api/admin/members/:slug/vote`, within the [agent vote rules](moderation.md#agent-votes). |

There are no other scopes. A grant does not make its holder `user`, `self` or
`staff` anywhere else ([authorization.md → Agent grants](../behaviors/authorization.md#agent-grants)).

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
  request. Revoking also stops the agent's staged votes from counting toward a
  purge ([person-lifecycle.md](../behaviors/person-lifecycle.md#scheduled-spam-purge)).
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
      "stagedVotes": { "spam": 3, "legit": 1 }
    }
  ]
}
```

`stagedVotes` counts the agent's votes on people no human has voted on.

## POST /api/admin/agents

```json
{
  "slug": "example-bot",
  "fullName": "Example Bot",
  "bio": "An AI ops bot run by … Its votes on /admin/members are staged; staff overrule them.",
  "grant": { "label": "ops bot, host vm-1", "scopes": ["moderation:read", "moderation:vote"], "expiresInDays": 90 }
}
```

`bio` is required (an agent says what it is). `grant` is optional. Creates the
person, an empty private profile, and the grant in one transaction; the slug
follows [slug-handles.md](../behaviors/slug-handles.md).

Response `201`: `{ person, grant, token }` — `token` only when a grant was
minted, and only in this response.

## POST /api/admin/agents/:slug/grants

`{ "label", "scopes", "expiresInDays" }` → `201 { grant, token }`. `404` when
`slug` is not an agent account (a member cannot be turned into an agent: create
the agent instead).

## POST /api/admin/agents/:slug/grants/:id/revoke

Sets `revokedAt = now()`. `200 { grant }`. Revoking a revoked grant is a no-op.

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
people a human has since voted on are left as the record. One commit.

Response `200`: `{ "withdrawn": 7, "reactivated": 5 }`. Withdrawing does not
revoke the grant; do both when the token itself is in doubt.

## Commits

Every write here is a commit on the data repo through the write mutex, by the
calling administrator or staff member, with `Action: agent.create`,
`agent.grant`, `agent.revoke` or `agent.withdraw-votes`, `Subject-Type: person`,
`Subject-Slug: <agent slug>`, and `Grant-Id: <id>` where one grant is
concerned. Agent grants are a change of access, so they are in the public audit
log the same way an account-level change is.

## Errors

- `422 validation_failed` — unknown scope, `expiresInDays` out of range,
  missing `bio`, bad or taken slug
- `404 not_found` — not an administrator (staff for `withdraw-votes`), or no
  such agent or grant
