---
status: in-progress
depends: []
specs:
  - specs/screens/chat.md
issues: [79]
---

# Plan: /chat Slack redirect

## Scope

[`specs/screens/chat.md`](../specs/screens/chat.md) declares `/chat` as a server-side 302 to the Code for Philly Slack workspace, optionally deep-linking to a channel via `?channel=foo`. Nothing serves it today — every "Open Slack" link across the SPA falls through to the SPA's catch-all (200 HTML).

The redirect rules from the spec:

| Request | Redirect target | HTTP |
|---|---|---|
| `/chat` | `https://<SLACK_TEAM_HOST>/` | 302 |
| `/chat?channel=foo` | `https://<SLACK_TEAM_HOST>/channels/foo` | 302 |
| `/chat?channel=` (empty) | Same as `/chat` | 302 |
| `/chat?channel=<invalid format>` | Same as `/chat`, with a log warn | 302 |

302 (temporary) rather than 301 so we can change the destination later without browser-cached redirects sticking.

Closes [#79](https://github.com/CodeForPhilly/codeforphilly-ng/issues/79).

## Implements

- [screens/chat.md](../specs/screens/chat.md) — full spec.

## Approach

### 1. Route, not hook

A plain Fastify `fastify.get('/chat', ...)` route. The two existing redirect plugins (`slug-redirect`, `legacy-redirect`) use `onRequest` hooks because they pattern-match across many URL shapes; `/chat` is exact and Fastify routing matches before the SPA notFoundHandler runs, so a route is the right shape.

### 2. Channel validation

The channel regex matches `Project.chatChannel` in `packages/shared/src/schemas/project.ts`: `/^[a-z0-9][a-z0-9_-]{0,40}$/`. Hoist that to a small shared constant or import the schema's pattern; either way the route gates on the same regex so a channel that came from a project record always works.

Invalid channels — including empty — fall back to the workspace root + a `warn` log entry with the offending value (URL-component-encoded to keep the log line safe). Per spec, no 4xx; just degrade.

### 3. Open-redirect protection

The host is hardcoded from env (`fastify.config.SLACK_TEAM_HOST`, already exists, defaults to `codeforphilly.slack.com`). The channel value only feeds the path segment, never the host. The regex restricts it to `[a-z0-9_-]` so there's no `..`, no `/`, no protocol smuggling.

### 4. Tests

`apps/api/tests/chat-redirect.test.ts`:

- `GET /chat` → 302, `Location: https://codeforphilly.slack.com/`
- `GET /chat?channel=general` → 302, `Location: …/channels/general`
- `GET /chat?channel=` → 302, root (no `/channels/`)
- `GET /chat?channel=foo/bar` → 302, root (regex rejects `/`)
- `GET /chat?channel=Capital` → 302, root (regex rejects uppercase)
- `GET /chat?channel=` with all `_` and `-` chars allowed (`philly_civic-tech`) → channel deep-link
- `Cache-Control` header — `no-cache` so changing the destination is immediate (302 is already temp, but the header is belt + suspenders)
- The route doesn't appear on `/api/*` paths — only on `/chat`. Verify `/api/chat` 404s as JSON.

## Validation

- [ ] Route registered, 302s match the spec table.
- [ ] Channel regex matches `Project.chatChannel`.
- [ ] Invalid channels fall back to root + emit a warn log.
- [ ] Existing 310 API tests still pass.
- [ ] `npm run type-check && npm run lint` clean.

## Risks / unknowns

- **Slack URL shape stability.** `/channels/<name>` is the current Slack deep-link path; if Slack changes it, our redirect breaks. Acceptable risk — the 302 means we can flip the destination in one commit.
- **No-cache header vs CDN.** 302s without explicit `Cache-Control` may be cached briefly by intermediaries. Adding `Cache-Control: no-cache` is cheap and matches the spec's "we can change the destination later" intent.

## Notes

_(filled at done time)_

## Follow-ups

_(filled at done time)_
