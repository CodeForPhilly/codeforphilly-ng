# Screen: Login

## Route

`/login` — public. If already signed in, redirects to `?return` or `/`.

`?return=/some/path` — optional URL to navigate to after successful login (must be a same-origin path, else ignored).

`?error=<code>` — optional. Set by the GitHub OAuth callback or `POST /api/auth/login` (via SPA error handling) when sign-in fails. Renders an inline error message keyed off the code.

## Data Requirements

- `GET /api/auth/me` — to detect existing session and redirect away
- `POST /api/auth/login` — for the password sign-in form (per [api/auth.md](../api/auth.md))
- `POST /api/auth/password-reset/request` — for the "Forgot your password?" affordance

## Display Rules

A single centered card, ≤ 480px wide.

### Title + body

- Title: "Sign in to Code for Philly"
- Body: "We use **GitHub** for sign-in. If you don't have a GitHub account yet, it's free and takes about a minute."
- A small "Why GitHub?" expandable disclosure: "We chose GitHub as the primary identity provider for three reasons: (1) the civic-tech community already lives there, (2) it filters spam and scam accounts more effectively than email-only sign-ups, and (3) most of our project work coordinates on GitHub anyway. Anyone can [create a GitHub account](https://github.com/signup) in under a minute."

### Primary CTA

A single full-width button:

- **Sign in with GitHub** — large, primary, with the GitHub mark icon

The button submits to `GET /api/auth/github/start?return=<encoded return>`.

### Returning members note

Below the button: "**Returning Code for Philly member?** If you had an account before our 2026 switch to GitHub sign-in, you can sign in with your old password below — or use GitHub if your old email matches."

### Secondary: legacy password sign-in

Below the GitHub CTA, a collapsed disclosure:

- Summary: **"Or sign in with your Code for Philly password"** (small button-style link with a key icon)
- When expanded, shows a form:
  - Label: "Username or email" — text input (`usernameOrEmail`)
  - Label: "Password" — password input (`password`)
  - Submit button: **"Sign in"**
  - Below the submit: a small link "Forgot your password?" → opens the password-reset request flow (a small inline form: enter username or email, submit, see "If we have an account on file we'll send you a reset link.")

The form submits to `POST /api/auth/login`. On 200 → navigate to `?return` or `/`. On 401 → render the inline error message (see below) keyed off `error.code`; don't reveal whether the username or the password was the failure. On 429 → "Too many sign-in attempts. Please wait a minute and try again."

The disclosure starts **collapsed** so GitHub remains the visually-dominant path. Users who don't have a legacy account never expand it.

### Error display

When `?error=<code>` is present (from the OAuth callback or the password-login response):

| Code | Message |
| ---- | ------- |
| `access_denied` | "You declined to authorize Code for Philly on GitHub. To sign in, you'll need to authorize the app." |
| `oauth_state_mismatch` | "Something went wrong with the sign-in flow. Please try again." |
| `oauth_session_invalid` | (same) |
| `github_unreachable` | "We couldn't reach GitHub. Please try again in a moment." |
| `email_unverified` | "Your GitHub account doesn't have a verified email address visible to us. To sign in here, please [verify a primary email on GitHub](https://github.com/settings/emails) and ensure email visibility is enabled for our app." |
| `invalid_credentials` | "The username or password you entered is incorrect." (rendered inline in the password form, not as a top-banner) |

## Actions

| Action | Effect |
| ------ | ------ |
| Sign in with GitHub | Navigate to `GET /api/auth/github/start?return=<encoded return>` |
| Sign in with password | `POST /api/auth/login` with `{ usernameOrEmail, password }` |
| Forgot your password? | `POST /api/auth/password-reset/request` with `{ usernameOrEmail }`; show "If we have an account on file we'll send you a reset link." on success (regardless of whether the account actually exists — anti-enumeration) |

## Navigation

**To here:** Header "Sign in" button on every page, after a session expires (with `?return=...` set to the page that 401'd), from any feature that requires authentication, from the GitHub OAuth callback when it errors.

**From here:**

- GitHub's OAuth authorization page (via the API redirect)
- After successful sign-in (either path): `?return` or `/`

## Authorization

Public. Already-authenticated visitors are redirected away (the SPA checks `GET /api/auth/me` and redirects if `person` is non-null).

## Coordinates with

- [api/auth.md](../api/auth.md) — both GitHub OAuth and `POST /api/auth/login`
- [behaviors/account-migration.md](../behaviors/account-migration.md) — the three-paths story
- [behaviors/password-hash-rotation.md](../behaviors/password-hash-rotation.md) — what happens server-side on password submit
