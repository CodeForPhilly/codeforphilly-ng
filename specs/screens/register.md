# Screen: Register

## Route

`/register` — public. If already signed in, redirects to `?return` or `/`.

`?return` — same semantics as [login.md](login.md).

## Data Requirements

- `GET /api/auth/me`

## Display Rules

- Centered card, ≤ 520px wide
- Title: "Join Code for Philly"
- Subtitle: "Create an account to join projects and post updates."
- Form:
  - Full name (`autocomplete="name"`)
  - Email (`autocomplete="email"`)
  - Password (`autocomplete="new-password"`) with strength hint:
    - "Too short" / "OK" / "Strong" indicator that updates as user types
    - Tooltip "We check passwords against known breach databases."
  - Slug (auto-filled from full name via slugify; user can edit)
    - Live availability check after 500ms debounce: ✓ available / ✗ taken
  - Checkbox: "I agree to the [Code of Conduct](/code-of-conduct)" — required to submit
  - Submit: "Create account"
- Below the form:
  - "Already have an account? Sign in →" → `/login?return=<return>`

## Validation

Inline per-field errors keyed on `error.fields`:

- `email` taken → "An account with this email already exists. [Sign in instead]"
- `slug` taken → "That username is taken. Try another."
- `password` rejected by HIBP → "This password has appeared in data breaches and isn't safe to use."

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| Submit | `POST /api/auth/register` | Navigate to `?return` or `/members/:slug` |
| Sign in instead | Navigation to `/login` | – |

After successful registration, a verification email is sent to `email`. The verification link points to a Fastify endpoint (deferred — see [api/auth.md](../api/auth.md) for the placeholder). v1 does **not** block usage on verification.

## Navigation

**To here:** Header "Sign up" button, "Create an account" link from `/login`, anywhere we gate features behind sign-in.

**From here:** `/` or `?return`, `/login`.

## Authorization

Public.
