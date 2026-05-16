# Behavior: Account Migration

## Rule

A laddr-era user signing in for the first time on the rewrite must be able to **claim their legacy account** so their slug, project memberships, authored updates/buzz, and Slack identity all carry forward. The cutover preserves continuity; nobody starts over.

## Applies To

- [api/auth.md](../api/auth.md) — GitHub OAuth callback decides whether to issue a session, route to claim, or create a new Person
- [api/account-claim.md](../api/account-claim.md) — the endpoints the claim screens hit
- [screens/account-claim.md](../screens/account-claim.md) — the user-facing claim UI
- [data-model.md](../data-model.md) — `Person.githubUserId`, `slackSamlNameId`, `PrivateProfile.email`, `LegacyPasswordCredential`
- [behaviors/private-storage.md](private-storage.md) — claims read+update the private store
- [behaviors/authorization.md](../behaviors/authorization.md) — staff-review path requires admin

## Signals available

At the GitHub OAuth callback we have:

- `gh.id` — GitHub's stable numeric user ID
- `gh.login` — GitHub username (mutable, but stable enough for soft hints)
- `gh.name` — display name
- `gh.emails: [{ email, primary, verified }, ...]` — all the user's GitHub emails with primary/verified flags

From the laddr import we have, for every legacy Person:

- `Person.slug` (= laddr `Username`) — public
- `PrivateProfile.email` (= laddr `Email`) — private
- `LegacyPasswordCredential.passwordHash` — private (until claimed and deleted)

## Matching algorithm at OAuth callback

```text
1. If Person.githubUserId === gh.id exists → already-linked, sign in (refresh PrivateProfile.email + Person.githubLogin)
2. Otherwise, look for legacy candidates:
   a. Email-match:    for each verified gh.email → PrivateProfile.email lookup
   b. Username-match: gh.login === Person.slug AND Person.githubUserId is null
3. Combine candidates, dedupe by Person.id
4. Route based on candidate count:
   - 0 candidates → create fresh Person + PrivateProfile (no claim needed)
   - 1 candidate → render single-candidate confirmation screen
   - N candidates → render multi-candidate picker
```

Email-match is the strong signal. Username-match is a hint — used only to surface a candidate, never to auto-claim.

## Claim outcomes

Each claim path produces one of three outcomes:

1. **Auto-claim** (email match + user confirms) — link GitHub identity to the legacy Person, delete `LegacyPasswordCredential`, refresh email
2. **Password-claim** (user types old username + password) — same as auto-claim, additionally verifying via `LegacyPasswordCredential`
3. **Decline** (user says "not me") — create fresh Person + PrivateProfile, leave the legacy candidate untouched

## Three identity proofs

For the user to claim a candidate, they must satisfy **at least one** of:

### A. Email match

The GitHub identity has a verified email that matches `PrivateProfile.email` for the candidate. The fact that GitHub verified the email is the proof.

**No additional user action required** — the OAuth flow already validated they control the GitHub account, which validated the email.

### B. Old-password verification

The user provides their pre-cutover username + password. The API:

1. Looks up the candidate Person by `slug`
2. Fetches `LegacyPasswordCredential.passwordHash`
3. Verifies the supplied password against the hash using the original laddr algorithm (likely bcrypt; confirmed at migration time)
4. On match: claim succeeds, `LegacyPasswordCredential` is deleted

This is for users whose pre-cutover email is dead but who remember their credentials.

### C. Staff approval

The user submits a claim request with their old slug + free-form proof (e.g., "I'm @alice in Slack — DM me"). The request goes to a staff queue. A staff member verifies via side-channel and approves or denies.

This is the fallback when both A and B are unavailable.

## Pre-cutover auto-link sweep

Before cutover, an admin script can pre-link Persons whose GitHub identity we know with confidence. Heuristics:

- Project `developersUrl` is a GitHub repo and the laddr Person is its maintainer → fetch the repo's owner via GitHub API, match
- Anyone who manually added a `https://github.com/<login>` URL to their laddr bio

Pre-linked Persons skip the claim flow entirely on first sign-in — the OAuth callback's `byGithubUserId` lookup hits immediately.

The sweep is **opportunistic**, not exhaustive. It improves the first-experience for a subset of users; the rest go through the normal claim flow.

## Merge semantics

If a user signs in via GitHub, creates a fresh Person (rejecting all candidates), and *later* realizes they had a legacy account, they can run a manual merge through `/account/claim-legacy` (post-onboarding claim — see [api/account-claim.md](../api/account-claim.md)).

The merge direction is **legacy-survives, fresh-folds-in**:

- All records authored by the fresh Person (updates, buzz, help-wanted, memberships) are re-pointed to the legacy Person's `id`
- The fresh Person is deleted (hard-delete; its `id` is gone)
- The legacy Person gains the GitHub identity link
- Anyone whose URL referenced the fresh Person's slug gets a 90-day `slug-history` redirect

Merge is admin-mediated (uses the staff approval path) to prevent accidental or malicious self-merges.

## Identity continuity for Slack

`Person.slackSamlNameId` (immutable per-Person, see [api/saml.md](../api/saml.md)) preserves Slack identity through:

- The migration (populated from `slug` at import time)
- Slug renames after cutover (stays put even if `slug` changes)
- Account claim (preserved because the legacy Person record is the one that's linked, not a new one)

A user's Slack workspace identity is therefore stable for the entire arc — laddr through rewrite through any future renames or claims.

## Anti-enumeration

The claim flow handles inputs the user may have wrong (old emails, old slugs). To avoid leaking which laddr accounts exist:

- **Old-password-verification endpoint** returns the same response for "no such slug" and "wrong password" — `401 unauthenticated` with `error.code = "claim_credentials_invalid"`.
- **Staff approval submission** always returns `202 accepted` regardless of whether the claimed slug exists.
- **Candidate enumeration at OAuth callback** is limited to candidates matching the user's actual GitHub-verified emails — we never reveal accounts the user couldn't have known about.

## Edge cases

**User has multiple legacy accounts** (rare but possible — different emails over time, one person with two profiles)

- All matching candidates surface in the picker.
- The user picks one; the others remain unclaimed.
- They can claim subsequent legacy accounts via `/account/claim-legacy` later and run a merge.

**User's verified GitHub emails match different legacy accounts**

- Multi-candidate picker. User picks one.

**Same legacy candidate matches via both email and username**

- Single candidate shown (deduped on `Person.id`). User confirms once.

**User starts the claim flow but abandons** (closes the tab after OAuth)

- Claim-pending JWT expires in 5 min. Next sign-in restarts the OAuth flow and re-resolves.
- No half-claimed state persists.

**A legacy Person is claimed but `LegacyPasswordCredential` failed to delete** (rare bucket failure)

- The credential is now unreachable (the Person it referenced is GitHub-linked, so the password-claim path won't accept it again — it checks `Person.githubUserId is null` before allowing password verification). The orphan record is cleaned up by the reconciliation script.

**User claims their account, then loses access to their GitHub account**

- v1 has no self-service GitHub-unlink flow. The user contacts staff, who can manually clear `Person.githubUserId` after side-channel verification (admin action, audit-logged).
- After unlink, the Person is in the "unclaimed" state again — they can sign in via a different GitHub account and re-claim, via email-match if email still works, else password-verification (if the cred is still there — usually deleted on first claim), else staff approval.

## Cutover-window policy

The `LegacyPasswordCredential` records are populated at cutover. Realistically, most users won't claim immediately. Suggested policy (operational decision, not spec-locked):

- **Day 0:** cutover. All laddr Persons are in unclaimed state. `LegacyPasswordCredential` records exist for all of them.
- **Day 0–90:** active claim period. Users sign in via GitHub OAuth; claim flow surfaces candidates.
- **Day 90:** mailout to remaining unclaimed addresses (via the address in `PrivateProfile.email`) reminding them to claim.
- **Day 180:** unclaimed `LegacyPasswordCredential` records can be deleted (the legacy Persons remain — anyone showing up later goes through staff approval).
- **Day 365:** consider soft-deleting unclaimed Persons or moving them to an inactive state.

This is operational policy, not enforced in code.

## Coordinates with

- [api/auth.md](../api/auth.md) — the OAuth callback is the entry point
- [api/account-claim.md](../api/account-claim.md) — endpoint surface
- [screens/account-claim.md](../screens/account-claim.md) — the UI
- [api/saml.md](../api/saml.md) — Slack identity continuity
- [data-model.md](../data-model.md) — fields involved
- [behaviors/private-storage.md](private-storage.md) — claim reads/writes the private store
