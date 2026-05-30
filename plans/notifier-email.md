---
status: in-progress
depends: []
specs:
  - specs/behaviors/help-wanted-roles.md
  - specs/api/projects-help-wanted.md
issues: [82]
---

# Plan: Real notifier — email-only first cut

## Scope

[`specs/behaviors/help-wanted-roles.md`](../specs/behaviors/help-wanted-roles.md) requires:

- **Express interest** notifies the project's maintainer — email required, Slack DM optional (deferred).
- **Auto-aging reminders** (90/180 days) — also deferred per the spec ("v1 ships without this").

Today's [`LoggingNotifier`](../apps/api/src/notify/index.ts) is a no-op stub that logs the intent and returns `delivered: true` without sending anything. This plan replaces it with a real email notifier for the two notification kinds the interface already declares (`notifyHelpWantedInterest`, `notifyHelpWantedFilled`).

**Email-only** is the agreed first cut — Slack DM is deferred to [#95](https://github.com/CodeForPhilly/codeforphilly-ng/issues/95) because sending DMs out from a workspace bot needs a different credential trust than our existing SAML-IdP-for-Slack relationship.

Closes [#82](https://github.com/CodeForPhilly/codeforphilly-ng/issues/82).

## Implements

- [behaviors/help-wanted-roles.md](../specs/behaviors/help-wanted-roles.md) — the "express interest" notification (email leg only).
- [api/projects-help-wanted.md](../specs/api/projects-help-wanted.md) — the route that triggers it.

## Approach

### 1. Pick a transport

Three options, in order of fit:

| | Pros | Cons |
|---|---|---|
| **Resend** (HTTPS API) | Modern, simple, generous free tier, good deliverability, no SMTP config | Adds a vendor account |
| **Postmark / SES** (HTTPS) | Similar shape | Same vendor-account overhead |
| **Generic SMTP** | No vendor lock-in | Deliverability is fragile from a small instance; spam reputation needs warming |

**Lean Resend.** Free tier covers our v1 traffic; their Node SDK is a single HTTPS call per send; failures surface as exceptions we can log + swallow per spec ("returns 202 to the caller regardless"). Vendor lock-in is shallow — Postmark/SES would be a one-file swap if we ever wanted to migrate.

### 2. Env

- `RESEND_API_KEY` — sealed secret in the cluster repo (`codeforphilly-ng.secrets/`). When unset, the notifier falls back to the existing `LoggingNotifier` so dev + test don't need a real key.
- `CFP_NOTIFICATION_FROM` — sender address. Default `"Code for Philly <notifications@codeforphilly.org>"`. Lives in the ConfigMap.

### 3. `EmailNotifier` class

`apps/api/src/notify/email-notifier.ts`:

```ts
export class EmailNotifier implements Notifier {
  constructor(opts: { resendApiKey: string; fromAddress: string; siteHost: string; logger: FastifyBaseLogger });

  async notifyHelpWantedInterest(n: HelpWantedInterestNotification): Promise<{ delivered: boolean }> {
    if (!n.maintainerEmail) {
      this.#log.warn({ ... }, 'help-wanted interest: no maintainer email; skipped');
      return { delivered: false };
    }
    const html = renderInterestEmail(n, this.#siteHost);
    const text = renderInterestText(n, this.#siteHost);
    try {
      await this.#resend.emails.send({ from, to, subject, html, text });
      return { delivered: true };
    } catch (err) {
      this.#log.error({ err, ... }, 'help-wanted interest: email send failed');
      return { delivered: false };
    }
  }

  // same shape for notifyHelpWantedFilled
}
```

### 4. Template

Plain-text + HTML alternative per the same payload. Templates live in `apps/api/src/notify/templates/`:

- `help-wanted-interest.{html,txt}.ts` — interpolates the notification fields into a short body.
- `help-wanted-filled.{html,txt}.ts` — sibling for the fill case.

Strings inline in TS (no template engine — they're small and we already have the data structured). The body links back to the role on the live site using `siteHost` from env (e.g. `https://next-v2.codeforphilly.org/projects/<slug>#help-wanted`).

### 5. Plugin wiring

Replace the LoggingNotifier construction in `apps/api/src/plugins/services.ts`:

```ts
const notifier: Notifier = fastify.config.RESEND_API_KEY
  ? new EmailNotifier({
      resendApiKey: fastify.config.RESEND_API_KEY,
      fromAddress: fastify.config.CFP_NOTIFICATION_FROM,
      siteHost: fastify.config.CFP_SITE_HOST,
      logger: fastify.log,
    })
  : new LoggingNotifier(fastify.log);
```

Logging fallback keeps tests + dev working without setup.

### 6. Tests

- Unit-test the template renderers (deterministic output for fixed inputs).
- Integration-test the notifier with a mock Resend SDK (`vi.spyOn` the `emails.send` method).
- Help-wanted-interest route test: confirms the route still returns 202 when the notifier throws (delivery failure must not fail the request per spec).

### 7. Spec/docs updates

- `specs/behaviors/help-wanted-roles.md` — no behavior change; the spec already declares email-required.
- `docs/operations/deploy.md` env table — add `RESEND_API_KEY`, `CFP_NOTIFICATION_FROM`.
- `docs/operations/secrets.md` — add `RESEND_API_KEY` to the sealed-secret roster.
- `.env.example` — document both new envs.

## Validation

- [ ] `EmailNotifier.notifyHelpWantedInterest` calls Resend with the right payload.
- [ ] Missing maintainer email → `delivered: false`, no Resend call, warning logged.
- [ ] Resend SDK throwing → `delivered: false`, error logged, **request still returns 202** (verified at route level).
- [ ] When `RESEND_API_KEY` is unset, the services plugin installs `LoggingNotifier` instead — existing tests unaffected.
- [ ] `CFP_NOTIFICATION_FROM` env defaults sensibly.
- [ ] Templates render with the expected interpolations (snapshot or assertion tests).
- [ ] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Deliverability warm-up.** A new Resend sender may get throttled / spam-filtered on day one. Mitigate by setting up SPF/DKIM/DMARC on `codeforphilly.org` before flipping the env on, and sending a few tests to known-good recipients first. Operator step, not code.
- **Bounce + complaint handling.** v1 doesn't subscribe to Resend's bounce webhooks. If a maintainer's email is dead, we'll log the failure but won't surface it back to the API consumer. *Tracked as a follow-up* once we have a UX hook (e.g., a "your maintainer's email bounced" surfaced on the project page).
- **Rate-limiting upstream.** Resend's free tier caps outbound; the rate-limiter on `/express-interest` already prevents floods, but worth double-checking the cap vs. our expected v1 traffic.
- **PII in logs.** The notifier logs `maintainerEmail` on failure, which lands in pod logs. Per [`behaviors/storage.md`](../specs/behaviors/storage.md) → "PII-aware redaction" we should be careful about that. Email-on-error-path is probably acceptable, but worth a redaction-stripping pass when implementing. (Slug + role title are fine.)

## Notes

*(filled at done time)*

## Follow-ups

*(filled at done time)*
