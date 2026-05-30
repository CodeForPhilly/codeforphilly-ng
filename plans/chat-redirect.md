---
status: done
depends: []
specs:
  - specs/screens/chat.md
issues: [79]
pr: 100
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

- [x] Route registered, 302s match the spec table.
- [x] Channel regex matches `Project.chatChannel`.
- [x] Invalid channels fall back to root + emit a warn log.
- [x] All tests pass — 319 API + 30 web + 69 shared.
- [x] `npm run type-check && npm run lint` clean.

## Risks / unknowns

- **Slack URL shape stability.** `/channels/<name>` is the current Slack deep-link path; if Slack changes it, our redirect breaks. Acceptable risk — the 302 means we can flip the destination in one commit.
- **No-cache header vs CDN.** 302s without explicit `Cache-Control` may be cached briefly by intermediaries. Adding `Cache-Control: no-cache` is cheap and matches the spec's "we can change the destination later" intent.

## Notes

Three commits: plan-open, feat (route + tests), closeout. The route
itself is ~50 lines including the JSDoc — the bulk of the work was
nailing the channel regex semantics so it matches what `Project.chatChannel`
already enforces, and writing the test sweep that exercises the
fall-back paths (empty, uppercase, slashes, leading hyphen, over-long).

Surprises:

- **Channel-regex hoist not needed.** I considered importing the
  `Project.chatChannel` Zod regex from `packages/shared/src/schemas/project.ts`
  so the two stay in lockstep, but Zod doesn't expose its underlying
  `RegExp` cleanly without `.shape` plumbing. A duplicated literal with
  a comment pointing at the canonical source is plainly the right
  trade-off here — the regex is one line, will rarely change, and any
  drift would be caught the next time someone adds a `Project.chatChannel`
  case to the route tests.
- **`request.query` typing.** Fastify's JSON-Schema querystring
  validator gives the handler a properly-typed `request.query` only
  when the JSON Schema's TypeScript-Provider is wired up. We don't
  have that across the codebase yet — every other route does
  `(request.query as { ... })`. Followed the established pattern
  rather than introducing TypeBox here.
- **`/api/chat` 404s as expected.** The route is registered without
  the `/api` prefix (Fastify's prefix only applies to plugin-scoped
  routes, and this route is registered at the app root). A test asserts
  that `/api/chat` returns 404 so future-me doesn't wonder whether it
  needed `/api/chat` for the spec.

## Follow-ups

- **Slack channel directory.** Eventually the spec'd Volunteer screen
  may want a typeahead of valid channels. Out of scope here; would be
  a separate enhancement on top of an actual Slack-integration story.
  *None* — not worth tracking until there's a real ask.
- **Per-channel analytics.** Knowing which `?channel=` deep-links get
  used would inform what to feature on the SPA. Tiny — could wrap the
  log line with a metric tag. *Deferred to plan* — bundle with the
  next observability pass if/when we wire metrics.
