---
status: done
depends: []
specs:
  - specs/api/auth.md
  - specs/behaviors/account-migration.md
  - specs/behaviors/password-hash-rotation.md
  - specs/screens/login.md
  - specs/screens/account.md
  - specs/deferred.md
issues: []
pr: 117
---

# Plan: login migration strategy — keep password login for existing users + nag-to-link-GitHub

## Scope

A directional change to the cutover auth strategy. Today's spec treats
GitHub OAuth as the only auth path; existing laddr users are gated by
a one-shot claim-at-cutover flow. The new design:

- **Existing users** can keep signing in with their old laddr password.
  Successful login auto-rehashes the unsalted-SHA1 credential to
  argon2id so the corpus drifts toward modern hashing without forcing
  resets.
- **New accounts** are still GitHub-only — preserves the spam argument
  that drove the original GitHub-only decision.
- **Linking GitHub** is a per-user opt-in surfaced via a persistent
  banner on `/account`. No deadline pressure; users link when ready.
- **Sunset** is deferred — no fixed deprecation date or coverage
  threshold today. Tracked separately when usage data justifies it.

This plan is **doc-only** — it captures the strategic shift across
the affected spec files. The implementation work (a real
`POST /api/auth/login` route, rehash logic, link flow, banner) lands
in a follow-up plan after these specs are reviewed.

## Implements

- [api/auth.md](../specs/api/auth.md) — new `POST /api/auth/login` + `POST /api/auth/link-github` + `/api/auth/me` field additions.
- [behaviors/account-migration.md](../specs/behaviors/account-migration.md) — rewritten around link-when-ready instead of gate-at-cutover.
- [behaviors/password-hash-rotation.md](../specs/behaviors/password-hash-rotation.md) — new doc: rehash-on-login + format-detection rules.
- [screens/login.md](../specs/screens/login.md) — secondary password login option.
- [screens/account.md](../specs/screens/account.md) — nag banner + link-GitHub card state.
- [deferred.md](../specs/deferred.md) — "email/password auth" entry flips from "deleted" to "kept for migrated users; sunset deferred."

## Approach

### 1. Why this shift makes sense

The original deferred-md entry argued GitHub-only because "Spam/scam load on the laddr sign-up form was unmanageable." That argument applies to **new signups**, not existing users. By restricting account *creation* to GitHub (unchanged), the spam argument still holds. Existing accounts already cleared whatever bar they cleared on laddr; making them re-prove identity is a UX speed bump with no security benefit.

The original spec's password-claim path also pretended bcrypt; in fact the laddr `passwordHasher` is `'SHA1'` (per `JarvusInnovations/emergence-skeleton/php-classes/User.class.php:33`). Unsalted SHA-1 is broken — rainbow tables crack every common password instantly. The new design treats *every* legacy credential as a "needs rehash" candidate and uses successful logins as the rotation trigger.

### 2. Login surface

`POST /api/auth/login` accepts `{ usernameOrEmail, password }` and:

1. Resolves to a `Person` by `slug` or by `PrivateProfile.email`
2. Loads `LegacyPasswordCredential.passwordHash`
3. Detects hash algorithm by format (bcrypt prefix → bcrypt; argon2 prefix → argon2id; bare 40-char hex → SHA-1)
4. Verifies — constant-time compare for the SHA-1 path
5. On success: **rehash** the supplied plaintext to argon2id, overwrite the credential, mint a session
6. On failure: uniform `401` with `error.code = "invalid_credentials"` — no distinction between "no such user" and "wrong password" (anti-enumeration)

### 3. Linking GitHub

When a signed-in user (legacy-password or GitHub) visits `/account`, they see a Card 1 ("Identity") whose contents depend on `Person.githubUserId`:

- **Linked** — green check, "Connected as @login", manage-on-github link
- **Not linked + has password creds** — yellow banner "Connect a GitHub account to make sign-in easier. (No deadline — just a recommendation.)" + a "Connect GitHub" button. The post-link experience is: GitHub OAuth round-trip → returns with `Person.githubUserId` populated → banner disappears.
- **Linked + has password creds** — quiet "Sign in via GitHub or password" indicator. Password credential stays until the user explicitly removes it (deferred) or we sunset.

The banner is the *only* nag — no email reminders, no modal interrupts, no toast on every login. Persistent and easy to dismiss-by-acting; non-blocking.

### 4. `/api/auth/me` new fields

```json
{
  "data": {
    "person": { ... },
    "accountLevel": "user",
    "hasGitHubLink": true,
    "lastLoginMethod": "github" | "legacy_password"
  }
}
```

The SPA uses these to decide:

- whether to render the banner
- whether the link-GitHub flow can act on the current session (it can if `hasGitHubLink === false`)

### 5. Password-recovery story

"Forgot my password" works the same as laddr today: user enters
their username or email, server emits a one-time link with a
`PasswordToken` (new behavior — see #2 below) to the address in
`PrivateProfile.email`. The token resets the password to a new
plaintext, which gets hashed argon2id on first save.

If the email on file is dead, the user is stuck — same as laddr. They
contact staff via side-channel (the existing staff-review path).

This adds a small amount of new code (`POST /api/auth/password-reset/request`, `POST /api/auth/password-reset/confirm`, a `PasswordToken` private record). It's the only real net-new code surface from the original spec — but it's necessary to keep password login viable.

### 6. Sunset

Deferred. No date, no coverage threshold, no automated deprecation
copy in v1. Add `lastPasswordLoginAt` to `LegacyPasswordCredential` so
the operator can later report "X% of active users have linked GitHub";
once that number's high enough, set a sunset date as a separate plan.

### 7. What the claim flow becomes

The existing account-claim flow stops being a **gate** and becomes an
**optional helper** for one specific case: a user signed in via GitHub
who didn't legacy-link automatically (no email match, no username
match) but knows they have a legacy account. Reachable from `/account`
"Claim another legacy account" — exactly the existing
`/account/claim-legacy` flow, just framed differently. Otherwise the
claim machinery is dormant for the common case.

Implication: the cutover-window policy in account-migration.md
(claims by day 90, mailout, expire by day 365) no longer applies.
Most users will sign in via password and never need to claim;
linking GitHub is a separate (later) UX.

## Validation

- [x] All six spec files updated to reflect the new strategy.
- [x] No dangling references to "claim at cutover is required" or "deleted on first successful claim." (`grep -r "deleted on first" specs/` returns no hits in the rewritten files; the claim flow is now framed as merge-helper-only.)
- [x] New `specs/behaviors/password-hash-rotation.md` covers SHA-1 detection + constant-time compare + rehash-on-login + argon2 params + anti-enumeration timing.
- [x] `specs/deferred.md` flips to "email/password account creation (sign-up) → GitHub-only," with explicit note that existing users keep password sign-in indefinitely.
- [ ] PR review confirms direction before any code changes land. *(this PR is the review surface)*

## Risks / unknowns

- **Tightly-coupled change set.** Six files cross-reference each
  other; landing only some of them creates a half-coherent spec.
  Bundle as one PR.
- **Password-reset is genuinely new code.** Out of scope for *this*
  spec PR but necessary for the implementation that follows.
- **Banner copy is placeholder.** "Connect a GitHub account to make
  sign-in easier" is okay-but-not-great. Worth iterating with the
  team during impl.
- **Anti-enumeration depth.** The login endpoint must return identical
  responses for "no such user" and "wrong password" — and ideally
  comparable timing too (else a timing oracle leaks user existence).
  Implementation detail captured in the password-hash-rotation spec.
- **Existing claim-flow code stays useful** but its UX framing changes
  significantly. The implementation PR (separate) needs to decide
  whether to refactor the existing routes or just add the new ones
  alongside.

## Notes

Doc-only PR. Two commits: plan-open + spec edits.

Surprises:

- **The "deferred entry" actually had a load-bearing argument the new design honors.** The original `deferred.md` "Email/password authentication" entry justified GitHub-only by citing laddr's spam-load problem. That argument is specifically about *sign-up*, not about existing users — so the new entry splits accordingly. The spam reasoning still applies to new-account creation, and the new design keeps that locked to GitHub. It does NOT apply to existing migrated users.
- **`crypto.timingSafeEqual` is strict on length.** The implementation note in `password-hash-rotation.md` calls this out: length-check first, then compare. Otherwise the length mismatch itself becomes a timing oracle (timingSafeEqual throws synchronously on length mismatch).
- **Anti-enumeration depth.** Initially considered keeping the "no such user" early-bail and just returning the uniform error, but that leaves a measurable timing gap (no DB read vs. hash verify is ~50 ms). The spec now requires the verifier to run a *dummy argon2* even when the user doesn't exist, so all four paths (no user, no credential, wrong password, unknown format) take comparable wall-clock time. Implementation will need to be careful here.
- **The claim flow stops being a gate but doesn't die.** `/account/claim-legacy` is repurposed from "the gate at first sign-in" to "the merge helper for duplicate accounts." Most users will never see it. The existing code (`AccountClaimService` etc.) can mostly stay; the UX framing changes.

## Follow-ups

- **Implementation plan** — `plans/login-migration-impl.md` to-be-written. Covers:
  - `POST /api/auth/login` route + verifier refactor (split `verifyLaddrPassword` into the three-algorithm dispatcher per the password-hash-rotation spec)
  - argon2id dep + params constants
  - `LegacyPasswordCredential` schema gains `lastUsedAt` field
  - `POST /api/auth/password-reset/{request,confirm}` routes + `PasswordToken` private record
  - `POST /api/auth/link-github` route + the link-mode OAuth callback variant
  - `/api/auth/me` response shape additions
  - SPA: secondary login form, password-reset flow, account banner
- **Sunset planning** — when usage data justifies, write `plans/legacy-password-sunset.md` to set a deprecation date.
- **`POST /api/auth/account-level`** (#33) — still open, unrelated to this work but adjacent. Stays separate.
