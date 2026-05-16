# Screen: Account Settings

## Route

`/account` — requires `user`.

A self-service settings hub for the current user's identity, sessions, newsletter prefs, and account state. Profile fields (name, bio, slug, tags, avatar) live on the **profile edit** flow (`/members/:slug/edit`) — this screen is for *account* concerns, not *profile* concerns.

## Data Requirements

- `GET /api/auth/me` — current person + account level (returns the self-view including the private-store email + newsletter prefs)
- `GET /api/auth/sessions` — list of remembered sessions

## Display Rules

The page is a vertical stack of cards.

### Card 1: Identity

- **GitHub account** — the linked GitHub login, with a green check ("Connected — primary identity")
  - Click "Manage on GitHub →" → opens `https://github.com/settings` in a new tab
  - No "Unlink" affordance in v1. If a user loses access to their GitHub account, recovery is via staff (see [behaviors/account-migration.md](../behaviors/account-migration.md))
- **Email** — read-only display of the current GitHub primary verified email
  - Small note: "Sourced from GitHub on every sign-in. To change, update your primary email on GitHub and sign back in here."
  - Refresh timestamp ("Last updated when you signed in on {date}")
- **Slack** — placeholder row with a greyed-out "Connect Slack" button (the linking flow isn't yet specified; the row signals direction)

### Card 2: Newsletter

- Toggle: "Receive Code for Philly newsletters"
  - Current state from `me.newsletter.optedIn`
  - On toggle: `PATCH /api/people/<me>/newsletter` (lives in the People API, mediates with the private store)
- If opted-in: small text "We'll send you newsletters at {email}. Unsubscribe links in every newsletter."
- If never opted-in: small text "We don't send newsletters by default."

### Card 3: Sessions

Heading: "Remembered sessions"

Sessions in this list are non-revoked refresh JWTs the API has side-channel metadata for (UA + IP + issue time). JWTs we don't have metadata for are still valid as long as their signature checks and they're not revoked, but they don't appear here. See [behaviors/authorization.md](../behaviors/authorization.md) for the JWT model.

Table (or card list at sm):

| Column | Content |
| ------ | ------- |
| Device | User agent parsed into "Chrome on macOS" form |
| Last seen from | IP address |
| Issued | `issuedAt` relative |
| Expires | `expiresAt` relative |
| Status | "Current" badge for the current session; "Revoke" button for others |

"Revoke" calls `POST /api/auth/sessions/:jti/revoke`. After success, the row disappears.

Below the table: "Sign out of this session" button → calls `POST /api/auth/logout` → redirect to `/`.

### Card 4: Claim another legacy account

- For users who signed in fresh (no legacy claim) OR who signed in via one legacy account and want to claim another
- Disclosed text: "Did you have another Code for Philly account from before we switched to GitHub sign-in? You can claim it here."
- Button "Find my old account →" → navigates to `/account/claim-legacy`

That post-onboarding claim flow follows the same shape as the OAuth-callback claim flow (see [screens/account-claim.md](account-claim.md)) but operates under a regular session, and approvals route through staff review with a merge — see [api/account-claim.md](../api/account-claim.md) and [behaviors/account-migration.md](../behaviors/account-migration.md).

### Card 5: Danger zone

- "Close my account" button → modal:
  - Body: "Closing your account hides your profile and updates from new visitors. Your past contributions remain visible to staff. This is not reversible by self-service — contact a Code for Philly staff member to undo."
  - Typed-confirmation: type your slug to enable submit
  - The self-serve close-account endpoint is not yet specified. The modal explains "Email <accounts@codeforphilly.org> to request closure."

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| Toggle newsletter | `PATCH /api/people/<slug>/newsletter` | Re-fetch me, success toast |
| Revoke session | `POST /api/auth/sessions/:jti/revoke` | Remove row from list |
| Sign out | `POST /api/auth/logout` | Redirect to `/` |
| Claim another legacy account | Navigate to `/account/claim-legacy` | – |
| Close account | (not yet specified) | Email-flow today |

## Navigation

**To here:**

- Profile page: "Manage account" link (visible to self only)
- Header user menu: "Account settings"

**From here:** `/` (after sign out), `/members/:slug/edit` (for profile fields), `/account/claim-legacy`.

## Authorization

`user`. Anonymous redirected to `/login?return=/account`.

Staff and administrators see exactly the same screen for *their own* account. There is no admin "view another user's sessions" surface in v1.
