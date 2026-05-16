# Screen: Login

## Route

`/login` — public. If already signed in, redirects to `?return` or `/`.

`?return=/some/path` — optional URL to navigate to after successful login (must be a same-origin path, else ignored).

`?error=<code>` — optional. Set by the GitHub OAuth callback when it redirects back here after a failure. Renders an inline error message keyed off the code.

## Data Requirements

- `GET /api/auth/me` — to detect existing session and redirect away

## Display Rules

A single centered card, ≤ 480px wide.

### Title + body

- Title: "Sign in to Code for Philly"
- Body: "We use **GitHub** for sign-in. If you don't have a GitHub account yet, it's free and takes about a minute."
- A small "Why GitHub?" expandable disclosure: "We chose GitHub as the sole identity provider for three reasons: (1) the civic-tech community already lives there, (2) it filters spam and scam accounts more effectively than email-only sign-ups, and (3) most of our project work coordinates on GitHub anyway. Anyone can [create a GitHub account](https://github.com/signup) in under a minute."

### Primary CTA

A single full-width button:

- **Sign in with GitHub** — large, primary, with the GitHub mark icon

The button submits to `GET /api/auth/github/start?return=<encoded return>`.

### Returning members note

Below the button: "**Returning Code for Philly member?** You'll be prompted to connect your old account after you sign in with GitHub."

### Error display

When `?error=<code>` is present:

| Code | Message |
| ---- | ------- |
| `access_denied` | "You declined to authorize Code for Philly on GitHub. To sign in, you'll need to authorize the app." |
| `oauth_state_mismatch` | "Something went wrong with the sign-in flow. Please try again." |
| `oauth_session_invalid` | (same) |
| `github_unreachable` | "We couldn't reach GitHub. Please try again in a moment." |
| `email_unverified` | "Your GitHub account doesn't have a verified email address visible to us. To sign in here, please [verify a primary email on GitHub](https://github.com/settings/emails) and ensure email visibility is enabled for our app." |

## Actions

| Action | Effect |
| ------ | ------ |
| Sign in with GitHub | Navigate to `GET /api/auth/github/start?return=<encoded return>` |

## Navigation

**To here:** Header "Sign in" button on every page, after a session expires (with `?return=...` set to the page that 401'd), from any feature that requires authentication, from the GitHub OAuth callback when it errors.

**From here:**

- GitHub's OAuth authorization page (via the API redirect)
- After successful sign-in: `?return` or `/`
- If the user has legacy candidates: `/account-claim` (transparent to the user — the callback redirects them there)

## Authorization

Public. Already-authenticated visitors are redirected away (the SPA checks `GET /api/auth/me` and redirects if `person` is non-null).

## Coordinates with

- [api/auth.md](../api/auth.md)
- [screens/account-claim.md](account-claim.md)
- [behaviors/account-migration.md](../behaviors/account-migration.md)
