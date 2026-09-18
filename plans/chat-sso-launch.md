---
status: in-progress
depends: [samlify-esm-interop]
specs:
  - specs/screens/chat.md
issues: []
pr: null
---

# Plan: `/chat/<channel>` signs into Slack and opens the channel

## Scope

Years of distributed links point at `codeforphilly.org/chat/<channel>`. On
laddr that URL signed the member into Slack via SAML and landed them in the
channel. The rewrite's `/chat` only accepted `?channel=` and redirected to
`https://<team>.slack.com/channels/<name>` — which assumes an existing Slack
session — and `/chat/<channel>` fell through to the SPA's 404.

In: spec the path form and the SSO-start target; implement; tests. Out:
IdP-initiated launch (`/api/saml/slack/launch` stays as-is); any change to
the project "Chat Channel" button, which already uses `?channel=`.

## Implements

- [screens/chat.md](../specs/screens/chat.md) — redirect rules: `/chat`,
  `/chat/<channel>`, `?channel=`; target is Slack's SP-initiated SSO start
  with `redir=/messages/<channel>/`; default channel `general`.

## Approach

- Match laddr exactly: `Emergence\Slack\Connector::handleLaunchRequest`
  redirected to `https://<team>.slack.com/sso/saml/start?redir=/messages/<channel>/`.
  Slack then drives the SP-initiated flow against `/api/saml/slack/sso`,
  verified live on 2026-09-18.
- `apps/api/src/routes/chat.ts`: one `launch()` helper behind `/chat` and
  `/chat/:channel`; invalid or empty channel → `general` (warn log on
  invalid). Fastify's default `ignoreTrailingSlash` handling covers
  `/chat/foo/`.
- Tests: rewrite `chat-redirect.test.ts` expectations to the SSO-start URL
  and add the path form + trailing slash + default channel.

## Validation

- `npm run type-check && npm run lint`; chat suite green.
- Live: `/chat/general` from a signed-out browser → CfP login → Slack opens
  in #general.

## Follow-ups

None.
