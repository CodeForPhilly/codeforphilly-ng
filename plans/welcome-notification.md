---
status: in-progress
depends: []
specs:
  - specs/api/auth.md
issues: [43]
---

# Plan: Welcome notification on fresh OAuth signup

## Scope

[`apps/api/src/auth/github-oauth.ts`](../apps/api/src/auth/github-oauth.ts) handles the GitHub OAuth callback. The `create-fresh` outcome — a brand-new user with no laddr-account-claim to do — writes a new `Person` + `PrivateProfile`, mints a session, and redirects. No welcome notification today.

This plan adds the third method to the `Notifier` interface (`notifyWelcomeOnSignup`) and fires it from the `create-fresh` path. With the `EmailNotifier` from [#82](https://github.com/CodeForPhilly/codeforphilly-ng/pull/98) already in place, the welcome email lands as soon as `RESEND_API_KEY` is sealed; until then, it logs via `LoggingNotifier`.

Closes [#43](https://github.com/CodeForPhilly/codeforphilly-ng/issues/43).

## Implements

- [api/auth.md](../specs/api/auth.md) — the GitHub OAuth flow's create-fresh user shape gets a notification side-effect.

## Approach

### 1. Extend the `Notifier` interface

In `apps/api/src/notify/index.ts`:

```ts
export interface WelcomeNotification {
  readonly email: string;       // PrivateProfile.email
  readonly fullName: string;    // Person.fullName
  readonly slug: string;        // Person.slug — used in the profile link
}

export interface Notifier {
  notifyHelpWantedInterest(n: HelpWantedInterestNotification): Promise<{ delivered: boolean }>;
  notifyHelpWantedFilled(n: HelpWantedFillNotification): Promise<{ delivered: boolean }>;
  notifyWelcomeOnSignup(n: WelcomeNotification): Promise<{ delivered: boolean }>;
}
```

Add the no-op `LoggingNotifier.notifyWelcomeOnSignup` and the real `EmailNotifier.notifyWelcomeOnSignup` — same shape as the existing two methods.

### 2. Welcome email template

`apps/api/src/notify/templates.ts` gains `renderWelcomeEmail(n, siteHost)`. Short, warm, single-CTA body:

- Subject: `Welcome to Code for Philly, <fullName>`
- Text body: 2-3 sentence intro pointing at the projects directory + Slack workspace
- HTML body: same content + styled link buttons
- Like the existing templates, HTML-escapes user-supplied fields (`fullName`)

### 3. Wire into the OAuth callback

In `apps/api/src/auth/github-oauth.ts`'s `create-fresh` branch, after `createFresh` resolves:

```ts
// Fire-and-forget the welcome notification — never block the redirect on
// notifier latency or failures. The spec for express-interest applies here
// too: returning 202/302 to the caller regardless of notification outcome.
void fastify.notifier
  .notifyWelcomeOnSignup({
    email: result.value.profile.email,
    fullName: result.value.person.fullName,
    slug: result.value.person.slug,
  })
  .catch((err) => {
    fastify.log.error({ err }, 'welcome notification threw (fire-and-forget)');
  });
```

Fire-and-forget — Notifier.notifyXxx already returns `{ delivered }` and swallows errors internally, but the outer `.catch` covers any unforeseen sync-throw before the SDK is reached. The OAuth callback's redirect happens on the next line, unblocked.

### 4. Tests

`apps/api/tests/welcome-notification.test.ts`:

- Template renderers — interest-style assertions for subject + body interpolation, HTML escape of `fullName`
- `EmailNotifier.notifyWelcomeOnSignup` — Resend success, Resend-error, SDK-throw, missing email (defensive — shouldn't happen on the create-fresh path since OAuth requires a primary email, but the interface accepts any string)
- `LoggingNotifier.notifyWelcomeOnSignup` — logs + returns `delivered: true`

Wiring-level test: the existing `github-oauth.test.ts` covers the `create-fresh` outcome end-to-end. Extend it with one case that asserts `fastify.notifier.notifyWelcomeOnSignup` was called with the right payload (vi.spyOn on the notifier). Don't test that the email *delivered* — that's a notifier-unit concern.

## Validation

- [ ] Three Notifier impls (interface + LoggingNotifier + EmailNotifier) all have the new method.
- [ ] EmailNotifier sends with the right Resend payload (subject + text + html + to).
- [ ] Welcome template HTML-escapes `fullName`.
- [ ] OAuth `create-fresh` path fires the notifier (verified via spy in github-oauth.test.ts).
- [ ] Existing OAuth tests continue to pass (the notifier call is fire-and-forget; doesn't change response shape).
- [ ] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Fire-and-forget vs await.** If we await, OAuth callback latency includes one Resend HTTPS round-trip — slow on a cold path, and a Resend outage would stall logins. Fire-and-forget trades email guarantees (a crash before the SDK enqueues drops the email silently) for response latency. Trade is right for v1; if delivery guarantees become important, a small outbox table is the canonical answer.
- **No retry on Resend failures.** Same trade-off — one shot, log the error, move on. Resend's own retry is good enough for transient blips.
- **No double-fire on duplicate signups.** OAuth `create-fresh` only fires when a Person was actually created (the `kind === 'create-fresh'` branch), so re-running the callback for an existing user doesn't re-send. Safe.
- **First-time-Login race with not-yet-sealed Resend key.** If the sandbox flips `RESEND_API_KEY` mid-signup, the in-flight request uses whatever notifier was installed at boot. Negligible — sealing the secret is a deploy event, the pod restart resets everything.

## Notes

*(filled at done time)*

## Follow-ups

*(filled at done time)*
