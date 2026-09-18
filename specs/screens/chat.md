# Screen: Chat launch

## Route

`/chat` and `/chat/<channel>` — public. Server-side redirect that signs the member into the Code for Philly Slack workspace and lands them in a channel.

`?channel=<name>` is accepted as an alternative to the path form (the project "Chat Channel" button uses it).

## Behavior

Not a rendered screen — a redirect endpoint handled at the API layer (and aliased on the web layer for nice URLs that work without JS).

The redirect targets Slack's **SP-initiated SSO start** URL, not the workspace directly. Slack then sends a SAML AuthnRequest to our IdP (`GET | POST /api/saml/slack/sso` — see [api/saml.md](../api/saml.md)), which signs the member in on our side if needed and posts the assertion back; Slack honours `redir` and opens the channel. This is the legacy laddr behaviour (`Emergence\Slack\Connector::handleLaunchRequest`), and the `codeforphilly.org/chat/<channel>` links distributed over the years depend on it.

### Redirect rules

| Request | Redirect target | HTTP |
| ------- | --------------- | :--: |
| `/chat` | `https://codeforphilly.slack.com/sso/saml/start?redir=%2Fmessages%2Fgeneral%2F` | 302 |
| `/chat/foo` | `https://codeforphilly.slack.com/sso/saml/start?redir=%2Fmessages%2Ffoo%2F` | 302 |
| `/chat?channel=foo` | Same as `/chat/foo` | 302 |
| `/chat/foo/` (trailing slash) | Same as `/chat/foo` | 302 |
| `/chat?channel=` (empty) | Same as `/chat` | 302 |
| `/chat/<invalid format>` or `?channel=<invalid format>` | Same as `/chat`, with a log warning | 302 |

The default channel is `general`, as in laddr.

`channel` is validated against the same regex as `Project.chatChannel` (`^[a-z0-9][a-z0-9_-]{0,40}$`) before interpolation, to prevent open-redirect / URL-injection on the Slack workspace URL. The host is always `SLACK_TEAM_HOST`.

Use **302** (temporary) rather than 301 so we can change the destination later without browser-cached redirects sticking.

### Why this exists

- Marketing materials and old links say "join us at codeforphilly.org/chat" and deep-link `codeforphilly.org/chat/<channel>` — historical, do-not-break.
- Project pages use `/chat?channel=<chatChannel>` for the "Chat Channel" button so the link looks like part of the site rather than an external Slack URL.
- If we move off Slack later, every link gets re-pointed by changing this one redirect rather than chasing references through the codebase.

## Open redirect protection

`channel` only feeds the `redir` value's path segment after `/messages/`; the host is hard-coded. No user input touches the host.

## Authorization

Public. The SSO round-trip that follows requires a Code for Philly sign-in, and Slack's own workspace membership rules still apply.
