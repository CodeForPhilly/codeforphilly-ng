# Screen: Forgot Password

## Route

- `/forgot-password` — public. Request a reset email.
- `/forgot-password/confirm?token=...` — public. Set a new password from a token.

## Data Requirements

None on entry. Submit triggers `POST /api/auth/password-reset/request` or `POST /api/auth/password-reset/confirm`.

## Display Rules

### `/forgot-password` (request)

- Centered card ≤ 480px
- H1: "Reset your password"
- Body: "Enter your email and we'll send you a link to set a new password."
- Form:
  - Email input (autocomplete "email", autofocus)
  - Submit "Send reset link"
- Below:
  - "Remembered it? Sign in →" → `/login`
- After successful submit, replace the form with:
  - Confirmation card: "Check your email. If an account exists for `<email>`, a reset link is on the way."
  - "Didn't get it?" — "Wait 60 seconds and try again." (the page enforces a 60s cooldown on the submit button)

The confirmation message is shown **regardless** of whether the email is registered (anti-enumeration).

### `/forgot-password/confirm?token=...`

- Centered card ≤ 480px
- H1: "Set a new password"
- Form:
  - New password input (autocomplete "new-password")
  - Confirm password input (autocomplete "new-password")
  - Strength hint (same widget as the register form, per [screens/register.md](register.md))
  - Submit "Set password and sign in"
- If passwords don't match: inline error on the second field
- If token is missing or empty: render an error card with "This reset link is invalid or expired. [Request a new one →]"
- If `POST /api/auth/password-reset/confirm` returns `401 invalid_token`: render the same error card (the link expired between landing on the page and clicking submit)
- On success: the API issues a session via the same cookie mechanism; redirect to `/` with a success toast "Password updated. You're signed in."

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| Submit email | `POST /api/auth/password-reset/request` | Replace form with confirmation card |
| Submit new password | `POST /api/auth/password-reset/confirm` | Redirect to `/` |

## Navigation

**To here:**

- From `/login` "Forgot your password?" link
- From the reset email (the `/confirm?token=...` variant)

**From here:** `/login`, `/`.

## Authorization

Public. If already signed in and visiting `/forgot-password`, redirect to `/`. The `/confirm` variant is reachable even when signed in (e.g., to reset another account from the same browser); on success, the new session replaces the old one.
