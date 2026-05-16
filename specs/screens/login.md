# Screen: Login

## Route

`/login` — public. If already signed in, redirects to `?return` or `/`.

`?return=/some/path` — optional URL to navigate to after successful login (must be a same-origin path, else ignored).

## Data Requirements

- `GET /api/auth/me` — to detect existing session and skip the form

## Display Rules

- Centered card, ≤ 480px wide
- Title: "Sign in to Code for Philly"
- Form:
  - Email input (`type="email"`, autocomplete "email", autofocus)
  - Password input (`type="password"`, autocomplete "current-password")
  - "Sign in" submit button (primary, full-width)
- Below the form:
  - "Forgot your password?" link to `/forgot-password`
  - Divider
  - "New here? Create an account →" link to `/register?return=<encoded return>`
- Error display:
  - Invalid credentials → inline error above the form: "Email or password incorrect."
  - Account disabled → inline: "This account has been disabled. Contact a Code for Philly staff member."
  - Rate-limited → inline: "Too many attempts. Try again in {n} minutes."
  - Network error → toast

Loading state: submit button shows spinner and is disabled; inputs disabled.

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| Submit | `POST /api/auth/login` | Navigate to `?return` (validated) or `/` |
| Forgot password | Navigation to `/forgot-password` | – |
| Register | Navigation to `/register` | – |

## Navigation

**To here:** Header "Login" button on every page, "Sign in" links from action gates, after a session expires (with `?return=...` set to the page that 401'd).

**From here:** `/`, `?return`, `/register`, `/forgot-password`.

## Authorization

Public. Already-authenticated visitors get redirected away — they don't see this form.
