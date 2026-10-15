# Moderation API

Staff-facing endpoints behind the [admin members screen](../screens/admin-members.md):
a newest-first roster of members with their footprint on the site, and a way to
record a **human spam verdict** that the offline spam pipeline treats as final
(see [behaviors/spam-exclusion.md](../behaviors/spam-exclusion.md)).

All endpoints require `accountLevel ∈ {staff, administrator}`. Anyone else gets
`404 not_found` — like the other staff surfaces, the endpoints' existence is not
a signal.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/api/admin/members` | Paginated roster, newest signup first, with vote state and footprint counts. |
| `GET` | `/api/admin/members/:slug` | One member's full footprint plus every human vote on record. |
| `POST` | `/api/admin/members/:slug/vote` | Record the caller's verdict; applies the side effect described below. |

## GET /api/admin/members

### Query parameters

| Param | Type | Notes |
| ----- | ---- | ----- |
| `q` | string | Substring match on `fullName`, `slug`, `bio`, and (staff-visible) `email` — searched for every query, so `.com` finds every member on that domain. Applies to the whole roster, then paginates. |
| `vote` | enum | `none` (no human vote yet) \| `spam` \| `legit`. Filters on the **latest** human vote. |
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
      "hasGitHubLink": true,
      "github": { "login": "janedoe", "accountCreatedAt": "2019-03-02T…", "publicRepos": 12, "followers": 40, "status": "ok", "checkedAt": "…" },
      "lastLoginAt": "2026-09-18T01:12:00Z",
      "signInCount": 4,
      "lastSlackSsoAt": "2026-09-18T01:15:00Z",
      "emailBounce": null,
      "bioExcerpt": "first ~160 chars of bio, markdown stripped",
      "footprint": { "memberships": 2, "updates": 1, "buzz": 0, "blogPosts": 0, "helpWantedInterest": 1, "tags": 3 },
      "latestVote": { "verdict": "legit", "voter": { "slug": "chris", "fullName": "Chris Alfano" }, "evaluatedAt": "…" },
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

`purgeAfter` is when the [scheduled spam purge](../behaviors/person-lifecycle.md#scheduled-spam-purge) will take the member — three days after the newest human vote, when every human vote is `spam` and the member is still deactivated and not staff — or `null`.

None of it is reachable by a non-staff caller (who gets 404 anyway). `latestVote` is `null`
when no human has voted.

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
      { "verdict": "spam", "reasoning": "…", "voter": { "slug", "fullName" }, "evaluatedAt": "…" }
    ]
  }
}
```

`votes` is newest first. Everything in `footprint` is drawn from the in-memory
public state — nothing here is fetched from elsewhere.

### Errors

- `404 not_found` — slug doesn't exist, or the caller is not staff

## POST /api/admin/members/:slug/vote

Record the caller's verdict on this person as a `person-evaluations` record with
`evaluator = "human-<callerSlug>"` (one record per voter per person — voting
again replaces the caller's previous record). Committed through the write mutex
as the caller, so the vote carries the voter's pseudonymous git identity.

### Request

```json
{ "verdict": "spam" | "legit", "reasoning": "optional, ≤ 1000 chars" }
```

### Side effects (per [behaviors/person-lifecycle.md](../behaviors/person-lifecycle.md))

- `verdict = "spam"` → the person is **deactivated** in the same transaction
  (`deletedAt = now()` if not already set).
- `verdict = "legit"` → if the person's previous **latest** human vote was `spam`
  (i.e. this vote reverses a moderation hide), `deletedAt` is cleared. A
  self-deactivation is left alone.
- Voting on yourself is rejected.

### Response — 200

```json
{ "success": true, "data": { "person": Person, "vote": { …the recorded vote… }, "latestVote": { … } } }
```

### Errors

- `422 validation_failed` — bad verdict, reasoning too long, or `slug` is the caller
- `404 not_found` — slug doesn't exist, or the caller is not staff

## Relationship to other specs

- [behaviors/spam-exclusion.md](../behaviors/spam-exclusion.md) — the
  `person-evaluations` record shape, why human votes live on `published`, and
  how the offline pipeline consumes them.
- [behaviors/person-lifecycle.md](../behaviors/person-lifecycle.md) — the
  deactivate side effect and its reversal rule.
- [api/people.md](people.md) — `deactivate`, `reactivate`, `purge`, and the
  staff-only fields reused here.

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
