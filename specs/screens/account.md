# Screen: Account Settings

## Route

`/account` — requires `user`.

A self-service settings hub for the current user's authentication, sessions, and account state. Profile fields (name, bio, slug, tags, avatar) live on the **profile edit** flow (`/members/:slug/edit`) — this screen is for *account* concerns, not *profile* concerns.

## Data Requirements

- `GET /api/auth/me` — current person
- `GET /api/auth/sessions` — list of active sessions

## Display Rules

The page is a vertical stack of cards.

### Card 1: Account

- Email (read-only display + "Change email" button)
- "Change email" opens a modal that re-prompts the password, then calls `PATCH /api/people/:slug` with `email`
- Email verification status:
  - If `emailVerifiedAt` is set: green check "Verified on {date}"
  - If null: amber notice "Not verified" with a "Resend verification email" button (calls a deferred endpoint; v1 shows the button but the click renders "Coming soon")

### Card 2: Password

- "Last changed: {relative time}" line
- "Change password" button → opens a modal:
  - Current password
  - New password (with strength hint)
  - Confirm new password
- Submit calls `PATCH /api/people/:slug/password` (deferred endpoint; not in v1's auth spec) — for v1, the modal text reads "Coming soon. Use [Reset your password →] for now" with a link to the password-reset flow

### Card 3: Sessions

Heading: "Active sessions"

Table (or card list at sm):

| Column | Content |
| ------ | ------- |
| Device | User agent parsed into "Chrome on macOS" form |
| Location | IP address (collapsed to "Last seen from `1.2.3.4`") |
| Started | `createdAt` relative |
| Expires | `expiresAt` relative |
| Status | "Current" badge for the current session; "Revoke" button for others |

"Revoke" calls `POST /api/auth/sessions/:id/revoke`. After success, the row disappears.

Below the table: "Sign out of this session" button → calls `POST /api/auth/logout` → redirect to `/`.

### Card 4: Connected services (deferred)

Placeholder card with greyed-out "Slack" and "GitHub" rows and a "Connect" button that opens a "Coming soon" modal. The card is visible in v1 to signal direction but does nothing.

### Card 5: Danger zone

- "Close my account" button → modal:
  - Body: "Closing your account hides your profile and updates from new visitors. Your past contributions remain visible to staff. This is not reversible by self-service — contact a Code for Philly staff member to undo."
  - Typed-confirmation: type your slug to enable submit
  - Submit calls a deferred endpoint `POST /api/people/me/close-account`. v1 surfaces the button but the modal explains "Coming soon. Email <accounts@codeforphilly.org> to request closure."

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| Change email | `PATCH /api/people/:slug` | Re-fetch me, toast "Email updated. Check your new address to verify." |
| Change password | (deferred) | Toast "Password updated." |
| Revoke session | `POST /api/auth/sessions/:id/revoke` | Remove row from list |
| Sign out | `POST /api/auth/logout` | Redirect to `/` |
| Close account | (deferred) | Email-flow today |

## Navigation

**To here:**

- Profile page: "Manage account" link (visible to self only)
- Header user menu: "Account settings"

**From here:** `/` (after sign out), `/members/:slug/edit` (for profile fields), the password reset flow.

## Authorization

`user`. Anonymous redirected to `/login?return=/account`.

Staff and administrators see exactly the same screen for *their own* account. There is no admin "view another user's sessions" surface in v1.
