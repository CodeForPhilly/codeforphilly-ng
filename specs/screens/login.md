# Screen: Login

## Route

`/login` — public. If already signed in, redirects to `?return` or `/`.

`?return=/some/path` — optional URL to navigate to after successful login (must be a same-origin path, else ignored).

## Data Requirements

- `GET /api/auth/me` — to detect existing session and skip the screen

## Display Rules

The page is a single centered card, ≤ 480px wide.

- Title: "Sign in to Code for Philly"
- Body: "We use GitHub for sign-in. If you don't have a GitHub account yet, it's free and takes about a minute."
- Primary CTA: **"Sign in with GitHub"** — full-width button with the GitHub mark
- Below the button: a small text block explaining that GitHub is the only sign-in method, with a link "Why GitHub?" → opens a tooltip / inline help explaining the choice (community is on GitHub, spam reduction, recovery story)
- Below that: "Returning member with an old codeforphilly.org account? You'll be prompted to claim it after you sign in."

The GitHub OAuth flow itself, the OAuth callback handler, and the account-claim prompts are not yet specified. Until they are, the "Sign in with GitHub" button has no API endpoint to hit — this screen is documenting intent.

## Actions

| Action | Effect |
| ------ | ------ |
| Sign in with GitHub | Navigate to `GET /api/auth/github/start?return=<encoded return>` (endpoint not yet specified) |

## Navigation

**To here:** Header "Login" button on every page, after a session expires (with `?return=...` set to the page that 401'd), from any feature that requires authentication.

**From here:** `?return` or `/` (after successful sign-in).

## Authorization

Public. Already-authenticated visitors get redirected away — they don't see this form.
