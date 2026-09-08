---
status: done
depends: [notifier-email]
specs:
  - specs/architecture.md
issues: []
pr: 158
---

# Plan: Postmark email transport

## Scope

Replace the Resend-backed email transport behind `EmailNotifier` with Postmark.
Project owner's call: "I want to keep using Postmark, resend was a random agent
choice." Postmark is the provider the legacy laddr site already sends through,
so the `codeforphilly.org` sender signature is verified there and no new
vendor account or DNS work is needed.

**In scope:**

- Spec + operator docs describe Postmark as the transactional email provider
  and the env surface it needs.
- A provider-neutral `EmailTransport` seam under `EmailNotifier`, with a
  Postmark adapter as the only vendor-aware file.
- Env rename `RESEND_API_KEY` → `POSTMARK_SERVER_TOKEN`, plus
  `POSTMARK_MESSAGE_STREAM` (default `outbound`).
- The T+90 `cutover-mailout` script sends through the same adapter.
- Tests for the adapter's field mapping and the SDK's wire format.

**Out of scope:**

- Any change to the `Notifier` interface, templates, or the fallback-to-
  `LoggingNotifier` / log-not-throw semantics established by
  [`notifier-email`](notifier-email.md).
- Sealing `POSTMARK_SERVER_TOKEN` in the cluster repo — operator step, tracked
  under Follow-ups.
- Bounce/complaint webhooks and Slack DM — still the follow-ups recorded on
  [`notifier-email`](notifier-email.md) and #95.

## Implements

- [architecture.md](../specs/architecture.md) — "Email: **Postmark**" in the
  stack table; `POSTMARK_SERVER_TOKEN` / `POSTMARK_MESSAGE_STREAM` /
  `CFP_NOTIFICATION_FROM` in the env table. The behaviours the notifier
  serves ([help-wanted-roles.md](../specs/behaviors/help-wanted-roles.md),
  [projects-help-wanted.md](../specs/api/projects-help-wanted.md),
  [auth.md](../specs/api/auth.md)) are transport-agnostic and unchanged.

## Approach

1. **Dependency swap first, alone.** `npm install -w apps/api postmark` then
   `npm uninstall -w apps/api resend`, committed on their own with the exact
   commands in the body.
2. **Specs and docs before code.** `specs/architecture.md`, `specs/deferred.md`,
   `docs/operations/{secrets,deploy,cutover,cutover-announcement}.md`, and the
   `deploy/kustomize/base/configmap.yaml` comment. Plans that mention Resend
   (`notifier-email`, `welcome-notification`, `test-harness`, `write-api`,
   `cutover-prep`, `login-migration-impl-phase-c`) are all frozen `done` and
   stay as-is.
3. **Introduce the seam.** `apps/api/src/notify/transport.ts` declares
   `OutboundEmail` (from/to/subject/text/html) and `EmailTransport.send()` →
   `{ messageId }`, throwing on any failure. `EmailNotifier` takes a
   `transport` instead of a Resend client; its four near-identical send blocks
   collapse into one `#deliver(label, ctx, to, tpl)` with a single catch.
4. **Postmark adapter.** `apps/api/src/notify/postmark-transport.ts` wraps a
   `PostmarkSender` (the `sendEmail` slice of `ServerClient`), maps onto
   Postmark's PascalCase `Message`, and stamps `MessageStream`. Boot wiring in
   `plugins/services.ts` builds `new ServerClient(POSTMARK_SERVER_TOKEN)` only
   when the token is set; otherwise `LoggingNotifier` exactly as before.
5. **Cutover script** reuses `PostmarkTransport` in place of its hand-rolled
   Resend `fetch`.
6. **Tests.** `email-notifier.test.ts` stubs the seam with `vi.fn()`. New
   `postmark-transport.test.ts` checks the field mapping with a stub client and
   runs the real `ServerClient` against an MSW intercept of
   `POST https://api.postmarkapp.com/email` (`createPostmarkMock`, replacing
   `createResendMock` in `tests/helpers/mocks.ts`).

## Validation

- [x] `grep -rniE resend specs docs plans apps packages deploy .env.example README.md` hits only frozen `done` plans.
- [x] `EmailNotifier` sends `{ from, to, subject, text, html }` through the transport and returns `delivered: true` with the provider message id logged.
- [x] Missing recipient → `delivered: false`, no transport call, warning logged (all four notification kinds).
- [x] Transport throwing (network blip or Postmark rejection carrying `code`/`statusCode`) → `delivered: false`, error logged, nothing thrown to the caller.
- [x] `PostmarkTransport` maps onto `{ From, To, Subject, TextBody, HtmlBody, MessageStream }`, defaults `MessageStream` to `outbound`, honours an override, and propagates SDK errors untouched.
- [x] Real `ServerClient` over MSW POSTs that exact JSON body to `https://api.postmarkapp.com/email` and surfaces `MessageID`.
- [x] When `POSTMARK_SERVER_TOKEN` is unset the services plugin installs `LoggingNotifier` — every pre-existing API test passes unchanged.
- [x] `POSTMARK_MESSAGE_STREAM` defaults to `outbound` in both the Zod schema and the `@fastify/env` JSON schema.
- [x] `import { ServerClient } from 'postmark'` resolves under plain Node ESM (Postmark ships CJS; verified with `node --input-type=module`).
- [x] `npm run type-check && npm run lint && npm test` clean: api 427/427, web 89/89, shared 75/75.

## Risks / unknowns

- **Message stream must exist on the server.** Postmark 422s a send whose
  `MessageStream` is unknown to that server. Default `outbound` exists on every
  server; anyone overriding it must create the stream first. Documented in
  `docs/operations/secrets.md`.
- **Inactive recipients.** Postmark refuses to send to addresses it has
  previously hard-bounced or that complained (`InactiveRecipientsError`, code
  406). Same `delivered: false` path as any failure; the logged `err` carries
  the code so operators can spot it.
- **CJS interop.** The `postmark` package is CommonJS with no `exports` map;
  named ESM imports rely on Node's cjs-module-lexer detecting
  `exports.ServerClient = …`. Verified for 5.1.0; a future SDK build that
  switches to `Object.defineProperty`-only exports would need a default import.

## Notes

- **Only one failure shape now.** Resend's SDK could throw *or* resolve with
  `{ error }`; Postmark's throws a `PostmarkError` subclass on every non-2xx.
  That let the notifier drop its per-method `if (result.error)` branches and
  share a single `#deliver`. The `err` logged carries `code` + `statusCode`, so
  the "was it the network or the provider" distinction the old two-branch log
  gave operators is preserved in the structured field rather than the message.
- **`MessageSendingResponse` is not a top-level export.** It lives under the
  `Models` namespace (`import type { Message, Models } from 'postmark'`);
  `Message` itself is top-level.
- **Stale local `node_modules` masqueraded as a type-check failure.** The first
  gate run failed in `apps/web` on a missing `marked` that was already in the
  lockfile on `develop`; `npm install` (no lockfile change) fixed it. Not
  related to this plan, noted so the next person doesn't chase it.
- **`createResendMock` had no callers.** It was harness scaffolding from
  [`test-harness`](test-harness.md); renamed to `createPostmarkMock` and given
  its first real consumer in `postmark-transport.test.ts`.
- **`--body-file` is not a `gh-axi pr create` flag.** Pass `--body "$(cat …)"`.

## Follow-ups

- Tracked as: seal `POSTMARK_SERVER_TOKEN` (and optionally
  `POSTMARK_MESSAGE_STREAM`) in `cfp-sandbox-cluster` `codeforphilly-ng.secrets/`
  per `docs/operations/secrets.md`; delete any `RESEND_API_KEY` sealed secret
  that was created. Until sealed, the pod keeps logging instead of sending.
- Bounce / complaint webhooks, PII redaction in notifier logs, and the Slack DM
  channel remain as recorded on [`notifier-email`](notifier-email.md) — Postmark
  offers the same webhook hooks, so nothing about those follow-ups changes.
