# Behavior: Account Migration

## Rule

A laddr-era user signs into the rewrite using **whichever they
remember** — their old laddr password OR a GitHub account that
matches their legacy email. Either path produces a session against
their existing Person record; their slug, project memberships,
authored updates/buzz, and Slack identity all carry forward.

New accounts can only be created via GitHub OAuth. Existing legacy
accounts keep password sign-in indefinitely. We *encourage* linking
GitHub (via a banner on `/account`) but never gate access on it.

The cutover preserves continuity; nobody starts over and nobody is
locked out by a deadline.

## Applies To

- [api/auth.md](../api/auth.md) — `POST /api/auth/login` (legacy password), `GET /api/auth/github/callback` (OAuth), `POST /api/auth/link-github`
- [api/account-claim.md](../api/account-claim.md) — the "claim another legacy account" helper for the rare merge case
- [screens/login.md](../screens/login.md) — login form with GitHub primary + password secondary
- [screens/account.md](../screens/account.md) — GitHub linking card with banner state
- [behaviors/password-hash-rotation.md](password-hash-rotation.md) — rehash-on-login, format detection, anti-enumeration
- [data-model.md](../data-model.md) — `Person.githubUserId`, `slackSamlNameId`, `PrivateProfile.email`, `LegacyPasswordCredential`
- [behaviors/private-storage.md](private-storage.md) — login + link write to the private store
- [behaviors/authorization.md](authorization.md) — staff-mediated paths for edge cases

## The three sign-in paths

```text
            ┌──────────────────────────────────────────────────────┐
            │                  /login                              │
            └────────────────┬─────────────────────┬───────────────┘
                             │                     │
              [Sign in with  │                     │  [Sign in with
                  GitHub]    │                     │      password]
                             │                     │
                             ▼                     ▼
            ┌──────────────────────┐    ┌──────────────────────┐
            │ GitHub OAuth →       │    │ POST /api/auth/login │
            │ resolve identity     │    │ verify, rehash if    │
            └──────┬───────────────┘    │ SHA-1, mint session  │
                   │                    └──────────────────────┘
                   │
       ┌───────────┼──────────────────────┐
       │           │                      │
    no laddr  matches a               matches none
    match     legacy candidate        but user might
       │      via email or            have a legacy
       │      username hint            account too (rare)
       ▼           ▼                      ▼
   create new   sign in to            sign in fresh;
   Person       legacy Person,        offer "Claim
   (GitHub-     auto-link             another legacy
   only)        GitHub                account" from
                                      /account
```

Path 1: **GitHub sign-in for a new account.** Fresh Person + PrivateProfile, GitHub-linked. The default for anyone who didn't exist on laddr.

Path 2: **GitHub sign-in matching a legacy account.** OAuth callback finds a verified email or username hint matching a legacy Person. The Person is auto-linked (GitHub identity bound, future GitHub sign-ins skip this resolution). No claim flow speed bump; the email match is the proof.

Path 3: **Password sign-in (legacy users only).** User enters their old laddr username/email + password. The `POST /api/auth/login` route verifies against `LegacyPasswordCredential` and mints a session. On success, the supplied password is rehashed to argon2id (see [password-hash-rotation.md](password-hash-rotation.md)).

A user can have **both** a password credential and a GitHub link active at the same time. That's the steady state for migrated users who've linked GitHub but haven't sunset their password.

## Signals available at the GitHub OAuth callback

- `gh.id` — GitHub's stable numeric user ID
- `gh.login` — GitHub username (mutable, but stable enough for soft hints)
- `gh.name` — display name
- `gh.emails: [{ email, primary, verified }, ...]` — all the user's GitHub emails with primary/verified flags

From the laddr import we have, for every legacy Person:

- `Person.slug` (= laddr `Username`) — public
- `PrivateProfile.email` (= laddr `Email`) — private
- `LegacyPasswordCredential.passwordHash` — private (kept after login; see below)

## Matching algorithm at OAuth callback

```text
1. If Person.githubUserId === gh.id exists → already-linked, sign in (refresh PrivateProfile.email + Person.githubLogin)
2. Otherwise, look for legacy candidates:
   a. Email-match:    for each verified gh.email → PrivateProfile.email lookup
   b. Username-match: gh.login === Person.slug AND Person.githubUserId is null
3. Combine candidates, dedupe by Person.id
4. Route based on candidate count:
   - 0 candidates → create fresh Person + PrivateProfile (no claim needed)
   - 1 candidate, email-match → auto-link, sign in (no confirmation screen)
   - 1 candidate, username-match only → render single-candidate confirmation screen
   - N candidates → render multi-candidate picker
```

Email-match is the strong signal — the user controls the GitHub
account, GitHub verified the email, the laddr account uses the
verified email. **One-step auto-link.** No confirmation screen,
no claim ceremony.

Username-match without email-match is a hint. Still requires
confirmation (the user might not be the legacy account holder).

## Legacy password sign-in

`POST /api/auth/login` accepts `{ usernameOrEmail, password }`:

1. Resolve `usernameOrEmail` to a Person — first try `slug`, then `PrivateProfile.email`
2. Load `LegacyPasswordCredential` for the Person; missing → uniform 401
3. Verify per [password-hash-rotation.md](password-hash-rotation.md):
   - Detect hash algorithm by format prefix
   - Constant-time compare for SHA-1; library-native compare for bcrypt/argon2
4. On success: **rehash** the supplied plaintext to argon2id and overwrite the credential record in the same request
5. On failure: uniform 401 `{ error.code: "invalid_credentials" }` — no distinction between "no such user," "wrong password," or "unknown hash format"

The endpoint is rate-limited at the auth-endpoint cap (10/min/IP per [api/conventions.md](../api/conventions.md)).

## Linking GitHub from an existing password-only session

`POST /api/auth/link-github`:

A signed-in user (regardless of which path they signed in via) can
link a GitHub account to their Person. The endpoint:

1. Starts a GitHub OAuth round-trip with a `link` scope tag in the signed session cookie (to distinguish it from a fresh sign-in)
2. After the callback returns with `gh.id`:
   - If `Person.githubUserId` is already set → 409 conflict, `error.code = "github_already_linked"`
   - If another Person has this `gh.id` → 409 conflict, `error.code = "github_id_in_use_elsewhere"` (rare — admin must merge)
   - Otherwise: set `Person.githubUserId = gh.id`, `Person.githubLogin = gh.login`, `Person.githubLinkedAt = now`
3. Optionally refresh `PrivateProfile.email` to the GitHub primary verified email (the user can decline this on the confirmation screen)

After linking, the user can sign in via *either* path. The password credential is **not** removed automatically — users keep both options until they explicitly remove the password (deferred) or we sunset.

## The nag (banner on `/account`)

A persistent yellow banner on `/account` when `Person.githubUserId === null`:

> **Connect a GitHub account to make sign-in easier.** GitHub sign-in
> is faster and works the same as your password. No deadline — this
> is just a recommendation.
>
> [Connect GitHub →]

The banner is the **only** nag mechanism. No modal interrupts, no
toast on every sign-in, no email reminders. Click "Connect GitHub" →
start the link flow. Linking → banner disappears.

If a user has already linked, the Identity card on `/account` instead
shows the green "Connected as @login" treatment — see
[screens/account.md](../screens/account.md).

## Password recovery

Lost-password recovery works as it did on laddr:

1. User enters their username or email on `/login`
2. Server emits a one-time signed token (`PasswordToken` private record, 1-hour expiry) via email to the address in `PrivateProfile.email`
3. User clicks the link, enters a new password
4. New password is hashed with argon2id and replaces the `LegacyPasswordCredential.passwordHash`

If the email on file is dead, the user contacts staff (existing
side-channel path). Email change is GitHub-sourced (the rest of the
spec); for users who haven't linked GitHub, "change my email" is a
staff-mediated process. We don't expose self-service email change to
password-only users in v1.

## Identity proofs (the rare "claim another account" case)

After a user signs in (any path) and lands at their session, they may
realize they have an *additional* legacy account they want to merge
in. The existing claim helper at `/account/claim-legacy` handles this
case — it's the rebadged remnant of the old claim flow.

For the merge to succeed, the user must satisfy one of:

### A. Email match

The GitHub identity (or current session) has a verified email matching `PrivateProfile.email` for the candidate.

### B. Old-password verification

User provides the candidate's pre-cutover password — verified against `LegacyPasswordCredential` per [password-hash-rotation.md](password-hash-rotation.md). On success the candidate is merged in (memberships, updates, buzz re-pointed) and the duplicate Person is hard-deleted.

### C. Staff approval

User submits a claim request with the old slug + free-form proof. Staff reviews via side-channel and approves or denies. Same as today.

These three proofs no longer gate first sign-in — they're only relevant for the manual "I have a duplicate account, merge it" case.

## Pre-cutover auto-link sweep

Before cutover, an admin script can pre-link Persons whose GitHub
identity we know with confidence:

- Project `developersUrl` is a GitHub repo and the laddr Person is its maintainer → match via the repo's owner
- Anyone who manually added a `https://github.com/<login>` URL to their laddr bio

Pre-linked Persons are GitHub-linked from day 0. They sign in via
either path; the banner stays hidden because `Person.githubUserId` is
already set.

The sweep is **opportunistic**, not exhaustive — it removes friction
for a subset of users.

## Merge semantics

If a user signs in fresh via GitHub (no auto-link), then later
realizes they had a legacy account, the merge direction is
**legacy-survives, fresh-folds-in**:

- All records authored by the fresh Person (updates, buzz, help-wanted, memberships) are re-pointed to the legacy Person's `id`
- The fresh Person is deleted (hard-delete; its `id` is gone)
- The legacy Person gains the GitHub identity link
- Anyone whose URL referenced the fresh Person's slug gets a 90-day `slug-history` redirect

Merge is admin-mediated (uses the staff approval path) to prevent accidental or malicious self-merges.

## Identity continuity for Slack

`Person.slackSamlNameId` (immutable per-Person, see
[api/saml.md](../api/saml.md)) preserves Slack identity through:

- The migration (populated from `slug` at import time)
- Slug renames after cutover (stays put even if `slug` changes)
- Either sign-in path (the legacy Person record is the one that's signed-into, not a new one)

A user's Slack workspace identity is therefore stable for the entire
arc — laddr through rewrite through any future renames or linkings.

## Anti-enumeration

The login + recovery flows handle inputs the user may have wrong (old
emails, old slugs, wrong passwords). To avoid leaking which laddr
accounts exist:

- **`POST /api/auth/login`** returns identical responses for "no such user," "wrong password," and "unknown hash format" — `401 unauthenticated` with `error.code = "invalid_credentials"`. Implementation must also normalize timing across these paths (constant-time SHA-1 compare, plus an artificial floor delay if the early bail-out is meaningfully faster than the verify path).
- **`POST /api/auth/password-reset/request`** always returns `202 accepted` regardless of whether the email exists. The actual mail is sent only if the address resolves.
- **Candidate enumeration at OAuth callback** is limited to candidates matching the user's actual GitHub-verified emails — we never reveal accounts the user couldn't have known about.

## Coverage metric (for future sunset planning)

`LegacyPasswordCredential` carries a `lastUsedAt` field (added with
this design). The operator can report on:

- Total `LegacyPasswordCredential` records
- Active password-sign-in users in the last 30/90/365 days
- Coverage % of `Person.githubUserId !== null` across active accounts

When that coverage is high enough to justify a sunset, a separate
plan sets a deprecation date and updates this spec. Until then, no
fixed sunset.

## Sunset (deferred)

Password sign-in for migrated users has no fixed deprecation date in
v1. The triggering signal — almost certainly a coverage threshold
("≥95% of monthly-active accounts have linked GitHub") — is captured
above and tracked separately when usage data justifies action.

## Edge cases

**User has multiple legacy accounts** (rare but possible — different emails over time)

- Sign-in via password works against whichever one's credentials they remember
- Multiple email-matches on GitHub OAuth surface in the candidate picker; user picks one
- Subsequent merges happen via `/account/claim-legacy`

**User's verified GitHub emails match different legacy accounts**

- Multi-candidate picker. User picks one. Same as today.

**User claims their account, then loses access to their GitHub account**

- v1 has no self-service GitHub-unlink flow. The user can still sign in via password if they remember it.
- If they've also forgotten the password, they recover via `password-reset` to their email-on-file.
- If the email is dead too, staff-mediated recovery.

**User has a GitHub link AND a password credential, wants to remove the password**

- Not v1. Deferred until sunset planning happens.

**Legacy Person was imported but has no email** (legacy data hygiene)

- Password sign-in by username still works.
- Password recovery doesn't (no destination). Staff path only.
- Banner still encourages linking GitHub; that path then captures a GitHub-verified email for the Person.

## Coordinates with

- [api/auth.md](../api/auth.md) — `POST /api/auth/login`, OAuth flow, link-github
- [behaviors/password-hash-rotation.md](password-hash-rotation.md) — rehash-on-login mechanics
- [api/account-claim.md](../api/account-claim.md) — the "claim another legacy account" merge helper
- [screens/login.md](../screens/login.md) — primary GitHub + secondary password
- [screens/account.md](../screens/account.md) — link banner + Identity card states
- [api/saml.md](../api/saml.md) — Slack identity continuity
- [data-model.md](../data-model.md) — fields involved
- [behaviors/private-storage.md](private-storage.md) — login and link both write the private store
