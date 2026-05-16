# Screen: Chat redirect

## Route

`/chat` — public. Server-side redirect to the Code for Philly Slack workspace.

Optional query parameter `?channel=<name>` redirects to a specific channel.

## Behavior

Not a rendered screen — a redirect endpoint handled at the API layer (and aliased on the web layer for nice URLs that work without JS).

### Redirect rules

| Request | Redirect target | HTTP |
| ------- | --------------- | :--: |
| `/chat` | `https://codeforphilly.slack.com/` | 302 |
| `/chat?channel=foo` | `https://codeforphilly.slack.com/channels/foo` | 302 |
| `/chat?channel=` (empty) | Same as `/chat` | 302 |
| `/chat?channel=<invalid format>` | Same as `/chat`, with a query log warning | 302 |

`channel` is validated against the same regex as `Project.chatChannel` (`^[a-z0-9][a-z0-9_-]{0,40}$`) before interpolation, to prevent open-redirect / URL-injection on the Slack workspace URL.

Use **302** (temporary) rather than 301 so we can change the destination later without browser-cached redirects sticking.

### Why this exists

- Marketing materials and old links say "join us at codeforphilly.org/chat" — historical, do-not-break.
- Project pages use `/chat?channel=<chatChannel>` for the "Chat Channel" button so the link looks like part of the site rather than an external Slack URL.
- If we move off Slack later, every link gets re-pointed by changing this one redirect rather than chasing references through the codebase.

## Open redirect protection

`channel` only feeds the path segment after `/channels/`; the host is hard-coded. No user input touches the host.

## Authorization

Public.
