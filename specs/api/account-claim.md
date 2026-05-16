# API: Account Claim

Endpoints for the legacy-account claim flow. See [behaviors/account-migration.md](../behaviors/account-migration.md) for the full rule set.

## Auth

Most endpoints accept a **claim-pending JWT** in the `cfp_claim` cookie. This is a short-lived (5 min) JWT minted by `/api/auth/github/callback` when candidate Persons are surfaced. It carries:

```json
{
  "sub": "<gh.id>",
  "scope": "claim",
  "candidates": ["<personId1>", "<personId2>"],
  "ghLogin": "...",
  "ghName": "...",
  "ghEmails": [{ "email": "...", "primary": true, "verified": true }, ...],
  "iat": ...,
  "exp": ...
}
```

The presence of `scope: "claim"` distinguishes this from a regular session JWT. Endpoints validate the scope explicitly — a `claim` JWT cannot perform regular API actions and vice versa.

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/account-claim/candidates` | claim-pending | Return the candidate Persons surfaced at OAuth callback. |
| `POST` | `/api/account-claim/confirm` | claim-pending | Confirm a specific candidate (email-match path). |
| `POST` | `/api/account-claim/decline` | claim-pending | Decline all candidates; create a fresh Person. |
| `POST` | `/api/account-claim/by-password` | claim-pending | Verify old slug + password to claim a candidate. |
| `POST` | `/api/account-claim/request-staff-review` | claim-pending | Submit a free-form claim request for staff to review. |
| `GET` | `/api/account-claim/legacy` | user | Post-onboarding: search for a legacy account to claim. |
| `POST` | `/api/account-claim/legacy/request` | user | Submit a post-onboarding claim request for staff review. |
| `GET` | `/api/staff/account-claim/queue` | staff | List pending claim requests. |
| `POST` | `/api/staff/account-claim/:requestId/approve` | staff | Approve a claim request. |
| `POST` | `/api/staff/account-claim/:requestId/deny` | staff | Deny a claim request. |

## GET /api/account-claim/candidates

Returns the candidates surfaced at OAuth callback, with enough detail for the user to recognize themselves.

### Response — 200

```json
{
  "success": true,
  "data": {
    "ghLogin": "janedoe",
    "ghName": "Jane Doe",
    "candidates": [
      {
        "personId": "01951a3c-...",
        "slug": "janedoe",
        "fullName": "Jane Doe",
        "memberOfCount": 3,
        "lastActiveAt": "2024-08-15T...",
        "matchedVia": ["email", "username"],
        "matchedEmail": "jane@example.com"
      }
    ]
  }
}
```

Each candidate's public-safe summary lets the user recognize themselves without exposing other private data. `matchedVia` is a hint to the UI (and the user) about why this candidate showed up.

### Errors

- `401 unauthenticated` with code `claim_token_invalid` — `cfp_claim` cookie missing or expired

## POST /api/account-claim/confirm

The user has selected a candidate and confirms it's them. **This works only for email-match candidates** — username-match alone is too weak to auto-claim.

### Request

```json
{ "personId": "01951a3c-..." }
```

### Behavior

1. Validate the `cfp_claim` JWT and check that `personId` is in the embedded `candidates` array
2. Re-verify the match: at least one of the user's `gh.emails[].verified` must equal `PrivateProfile.email` for the claimed Person
3. **Inside a `repo.transact`:** set `Person.githubUserId`, `Person.githubLogin`, `Person.githubLinkedAt` on the legacy Person
4. **PUT private store:** update `PrivateProfile.email` to the GitHub primary verified email and `emailRefreshedAt = now`; delete the `LegacyPasswordCredential` if present
5. Clear `cfp_claim` cookie
6. Issue session JWT pair (access + refresh)
7. Return 200 with `{ person, accountLevel }`

### Response — 200

```json
{ "success": true, "data": { "person": { /* ... */ }, "accountLevel": "user" } }
```

Sets `cfp_session` + `cfp_refresh` cookies. Clears `cfp_claim`.

### Errors

- `401 unauthenticated` with code `claim_token_invalid`
- `403 forbidden` with code `not_a_candidate` — `personId` isn't in the claim JWT's candidate list
- `403 forbidden` with code `email_match_required` — username-only match; user must use `by-password` or `request-staff-review` instead
- `409 conflict` with code `already_claimed` — the candidate has been claimed by someone else between the OAuth flow and this call (race; rare)

## POST /api/account-claim/decline

User says none of the candidates are them; create a fresh Person.

### Request

Empty.

### Response — 201

Same shape as `confirm`. Creates a new Person + PrivateProfile from the GitHub identity, issues session.

The declined candidates are **not** modified — they remain available for someone else (the right user) to claim later.

## POST /api/account-claim/by-password

Verify a legacy username + password to claim. The user supplies these explicitly — typically when their pre-cutover email is dead and email-match didn't work.

### Request

```json
{
  "slug": "janedoe",
  "password": "..."
}
```

### Behavior

1. Validate `cfp_claim` JWT (the user must have completed OAuth first)
2. Look up the Person by `slug`. If not found OR if `Person.githubUserId is not null` (already claimed): return uniform 401
3. Fetch `LegacyPasswordCredential.passwordHash` for that Person from the private store. If not found: return uniform 401
4. Verify the supplied password against the hash using the legacy algorithm
5. On match: proceed as in `confirm` (link GitHub identity, refresh email, delete `LegacyPasswordCredential`, issue session)

### Response — 200

Same as `confirm`.

### Errors

- `401 unauthenticated` with code `claim_credentials_invalid` — uniform response for "no such slug," "already claimed," or "wrong password"
- `401 unauthenticated` with code `claim_token_invalid` — `cfp_claim` cookie missing or expired

## POST /api/account-claim/request-staff-review

Submit a free-form claim request. Used when neither A nor B is available (dead email AND lost password).

### Request

```json
{
  "claimedSlug": "janedoe",
  "evidence": "I'm @alice in CFP Slack. I used the account in 2021–2023 for the PHLASK project. Email me at jane@new-job.com to verify."
}
```

### Behavior

1. Validate `cfp_claim` JWT
2. Create an `AccountClaimRequest` record in the private store with `personId` of the claimed slug (if it exists), the user's GitHub identity, and the free-form evidence
3. Return 202 regardless of whether the slug exists (anti-enumeration)

### Response — 202

```json
{ "success": true, "data": { "delivered": true } }
```

The user is informed that a staff member will follow up via the email they listed in the evidence (or via Slack DM).

## GET /api/account-claim/legacy

**Post-onboarding** entry point. The user is signed in (via a fresh account or a previously-claimed legacy account) and realizes they had *another* legacy account.

### Query

| Param | Required | Notes |
| ----- | -------- | ----- |
| `q` | yes | The old slug or old email they remember |

### Response — 200

Returns at most one matching candidate (or zero). Same shape as the candidate object in `GET /candidates`, with `matchedVia` set based on what `q` matched.

Anti-enumeration: if nothing matches, response is still 200 with an empty `candidates` array. We don't reveal which slugs exist.

## POST /api/account-claim/legacy/request

Submit a staff-review request from the post-onboarding flow.

### Request

```json
{
  "claimedSlug": "janedoe",
  "evidence": "..."
}
```

Same shape as `/api/account-claim/request-staff-review`. The difference: the user is already signed in to a Person, so the request is linked to *both* identities — staff approval merges them per [behaviors/account-migration.md#merge-semantics](../behaviors/account-migration.md#merge-semantics).

### Response — 202

## Staff queue endpoints

### GET /api/staff/account-claim/queue

Lists pending `AccountClaimRequest` records.

```json
{
  "success": true,
  "data": [
    {
      "requestId": "...",
      "claimedSlug": "janedoe",
      "claimedPersonId": "01951a3c-...",
      "requesterGithubLogin": "janedoe",
      "requesterPersonId": null,
      "evidence": "...",
      "submittedAt": "...",
      "type": "pre-onboarding" | "post-onboarding-merge"
    }
  ]
}
```

### POST /api/staff/account-claim/:requestId/approve

Approve a request. For pre-onboarding (no requesterPersonId): link the GitHub identity to the claimed Person, issue the user's first session next time they sign in. For post-onboarding (has requesterPersonId): merge the requester's fresh Person into the claimed legacy Person.

**Inside a `repo.transact`:**

- Pre-onboarding: set `Person.githubUserId/Login/LinkedAt` on the claimed Person
- Post-onboarding-merge: re-point all records authored by `requesterPersonId` to `claimedPersonId`, set `Person.githubUserId` from the requester onto the claimed Person, hard-delete the requester Person, write a `slug-history` entry redirecting the requester's old slug

Audit-logged via commit trailers (`Action: account-claim.approve`, `Subject-Slug: <claimed slug>`, `Actor-Slug: <staff slug>`, `Reason: <staff note>`).

### POST /api/staff/account-claim/:requestId/deny

Mark the request denied. Optionally include a denial reason that's emailed to the requester.

## Notes

- `AccountClaimRequest` records live in the **private store** (they contain free-form evidence that may include PII). Storage path: `account-claim-requests.jsonl` in the private bucket, alongside `profiles.jsonl` and `legacy-passwords.jsonl`. (Filed under [behaviors/private-storage.md](../behaviors/private-storage.md) as a third entity in the private store.)
- The post-onboarding merge is admin-mediated to prevent accidental or malicious self-merges. There's no self-service "merge two accounts I have" endpoint.
- All claim approvals/denials produce commit trailers per [behaviors/storage.md](../behaviors/storage.md#commit-message-shape) — the public audit log records *that* a claim happened, even though the *evidence* and email matchers are private.

## Coordinates with

- [api/auth.md](auth.md)
- [behaviors/account-migration.md](../behaviors/account-migration.md)
- [behaviors/private-storage.md](../behaviors/private-storage.md)
- [behaviors/authorization.md](../behaviors/authorization.md) — staff endpoints require `staff` or `administrator`
- [screens/account-claim.md](../screens/account-claim.md)
