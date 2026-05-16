# Screen: Account Claim

## Route

`/account-claim` — entered automatically from the GitHub OAuth callback when candidates exist. Requires a `cfp_claim` JWT cookie (5-minute lifetime).

`/account-claim/by-password` — secondary route within the same flow.

`/account-claim/request-staff-review` — fallback within the same flow.

If `cfp_claim` is missing/expired: redirect to `/login`.

## Data Requirements

- `GET /api/account-claim/candidates` on entry

## Display Rules

### Top-level decision tree

```text
GET /candidates returns N candidates
        │
        ├─ N === 1 ─→ "Confirm it's you" single-candidate screen
        ├─ N >= 2 ─→ "Pick which is you" multi-candidate screen
        └─ N === 0 ─→ shouldn't happen here (callback wouldn't have redirected); show error
```

Across all variants:

- Header: "Welcome back" if any candidate matched via email; "Almost there" if only username-match
- Subheader: brief explanation — "We think you might have a Code for Philly account from before our recent upgrade. We're trying to connect your GitHub identity to it so you don't lose your project memberships and history."

### Single-candidate screen (N = 1)

A card showing:

- The candidate's avatar + `fullName` + `slug`
- "Member since {createdAt:'MMM yyyy'}"
- "Member of N project(s): <list project titles, linked>"
- "Last active {lastActiveAt relative}"
- For email-match candidates: green check next to the matched email ("matched via {email}")
- For username-only candidates: a yellow warning "matched via username only — please verify"

Buttons:

- **Yes, this is me** — primary, full-width
  - Email-match: calls `POST /api/account-claim/confirm` → on success, redirect to `?return` or `/`
  - Username-only: this button is replaced with "Verify with old password →" linking to the password sub-screen
- **No, this isn't me — start fresh** — secondary, calls `POST /api/account-claim/decline`
- **I don't recognize this account** — tertiary link below; opens a help disclosure explaining the claim flow

### Multi-candidate screen (N ≥ 2)

A list of cards (same shape as the single-candidate card, but compact). Each card has its own "This is me" button. Below the list:

- "None of these are me — start fresh" button → `POST /api/account-claim/decline`

### `/account-claim/by-password` sub-screen

Reached via a "Verify with old password" link from a username-only candidate OR from a "Have an old account we didn't find?" link.

Form:

- Old username (pre-filled with the candidate's slug if arriving from a candidate; empty if free-search)
- Old password
- Submit "Verify"

On submit:

- `POST /api/account-claim/by-password` with the slug + password
- On success: redirect to `?return` or `/` with a "Welcome back" toast
- On `401 claim_credentials_invalid`: inline error "Username or password didn't match"
- Below the form: "I don't remember my password" link to `/account-claim/request-staff-review`

### `/account-claim/request-staff-review` sub-screen

Form:

- Claimed username
- "Evidence" — free-form textarea (placeholder: "Tell us who you are in CFP — your Slack handle, projects you worked on, an email a staff member can reach you at. We'll follow up within a few days.")
- Submit "Send to staff"

On submit:

- `POST /api/account-claim/request-staff-review`
- Always returns 202; replace form with confirmation: "Submitted. A Code for Philly staff member will reach out via the contact you provided. In the meantime you can start fresh: [Continue as a new member →]"
- "Continue as a new member" button on the confirmation also fires `POST /api/account-claim/decline` so the user has a usable session immediately

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| "Yes, this is me" (email match) | `POST /api/account-claim/confirm` | Redirect to `?return` or `/` |
| "No, this isn't me" / "Start fresh" | `POST /api/account-claim/decline` | Redirect to `?return` or `/` |
| Verify with old password | `POST /api/account-claim/by-password` | Redirect to `?return` or `/` |
| Send to staff | `POST /api/account-claim/request-staff-review` | Show submitted confirmation |
| Continue as new member (after staff submission) | `POST /api/account-claim/decline` | Redirect to `?return` or `/` |

## Navigation

**To here:** From `/api/auth/github/callback` when candidates exist (server-side redirect).

**From here:**

- `?return` or `/` after success
- Could navigate away mid-flow — `cfp_claim` JWT expires in 5 min, but until then the user can come back and pick up where they left off

## Authorization

Public route, but **requires `cfp_claim` JWT** in the cookie. A regular signed-in user (with `cfp_session`) doesn't see this screen — the post-onboarding equivalent is on the [account settings](account.md) page (`/account/claim-legacy`).

If both `cfp_claim` and `cfp_session` are present, `cfp_session` wins and the user is redirected to `/account` — the claim flow isn't meant to be entered while already signed in.

## Coordinates with

- [api/account-claim.md](../api/account-claim.md)
- [behaviors/account-migration.md](../behaviors/account-migration.md)
- [screens/login.md](login.md)
- [screens/account.md](account.md) — post-onboarding claim entry
