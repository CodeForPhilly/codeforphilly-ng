---
status: done
depends: [admin-members-moderation]
specs:
  - specs/screens/admin-members.md
  - specs/api/moderation.md
  - specs/api/auth.md
  - specs/api/saml.md
  - specs/api/webhooks.md
  - specs/behaviors/private-storage.md
  - specs/behaviors/spam-exclusion.md
issues: []
pr: 189
---

# Plan: roster signals — origin, GitHub reputation, Slack SSO, bounces

## Scope

The first day on `/admin/members` showed the roster makes staff read four
fields to reach "this is a throwaway": no sign-in, no avatar, free-mail
address that doesn't match the name, zero footprint. And the signals that
matter most — did they arrive through GitHub, is GitHub still vouching for
them, have they ever used Slack, does their mailbox exist — were either
invisible (origin), discarded at sign-in (GitHub profile facts), never
recorded (Slack SSO), or never collected (bounces). Spammers are now arriving
through GitHub OAuth, so GitHub's own moderation (suspended/deleted accounts)
is the highest-value new signal.

In:

1. **Row-local signals** on the roster: origin (imported vs signed up here),
   name/email mismatch, bio link count / no bio, no avatar, sign-in count, an
   attention tint computed from those facts; origin filter; default vote
   filter "no vote yet"; `j`/`k`/`s`/`n`/`Enter` keys.
2. **GitHub reputation** captured at every GitHub sign-in (account age, public
   repos, followers, following, type) into the private profile, and a
   **staleness-driven probe** (`GET /user/{id}` with the OAuth app's client
   credentials) that marks linked accounts `ok` / `gone` — run lazily for the
   rows on a roster page when older than a day.
3. **Slack SSO stamp** — `lastSlackSsoAt` on the private profile whenever the
   IdP issues an assertion.
4. **Postmark bounce webhook** — `POST /api/_webhooks/postmark/bounce` stores
   hard bounces / spam complaints on the private profile.
5. **`probe-github` evaluator** in the private spam-detection repo: gone
   accounts → `spam` (0.95); old, active accounts → `legit` (0.9) so the prune
   never removes someone GitHub vouches for.

Out: SMTP/RCPT probing (unreliable, gets the IP listed); Slack workspace
membership on the roster (needs the pipeline to stamp it; later); bulk votes.

## Implements

- [screens/admin-members.md](../specs/screens/admin-members.md) — badges,
  attention tint, filters, keys.
- [api/moderation.md](../specs/api/moderation.md) — new row fields
  (`origin`, `github`, `lastSlackSsoAt`, `signInCount`, `emailBounce`,
  `signals`), `origin` filter.
- [api/auth.md](../specs/api/auth.md) — GitHub profile facts kept at sign-in.
- [api/saml.md](../specs/api/saml.md) — assertion issuance stamps the profile.
- [api/webhooks.md](../specs/api/webhooks.md) — the Postmark bounce endpoint.
- [behaviors/private-storage.md](../specs/behaviors/private-storage.md) —
  `github`, `lastSlackSsoAt`, `emailBounce` on the profile record.
- [behaviors/spam-exclusion.md](../specs/behaviors/spam-exclusion.md) — the
  `github-probe` evaluator.

## Approach

- `packages/shared`: extend `PrivateProfileSchema` (all new fields optional so
  existing `profiles.jsonl` lines still parse).
- `auth/github-client.ts`: `fetchGitHubUser` keeps the reputation fields;
  `probeGitHubUser(id, clientId, clientSecret)` returns `{status, facts}`
  (404 → `gone`; other non-2xx → throw, caller keeps the old record).
- `services/github-account.ts`: create / refresh / link all write
  `profile.github`.
- `routes/saml.ts`: one helper stamps `lastSlackSsoAt` after each of the three
  `renderPostForm` sites.
- `routes/webhooks.ts`: bounce endpoint, bearer or basic-auth secret
  (`POSTMARK_WEBHOOK_SECRET`), 503 when unset, 200 always once authenticated,
  resolves `Email` → person via the private store's email index.
- `services/moderation.ts`: row assembly gains the new fields and `signals`;
  a `GitHubProbe` dependency (injected; absent in tests and when the OAuth app
  isn't configured) refreshes stale `github` records for the rows on the page
  with bounded concurrency before serialising.
- Web: chips and tint per spec; `origin` filter; default `vote=none`;
  keyboard handler at the page level.
- Private repo: `scripts/probe-github.ts` + `npm run probe-github`.

## Validation

- Unit: signals computed from fixtures (mismatch, links, no bio); probe
  results persisted; stale/fresh gating; bounce webhook auth + mapping;
  SAML stamp after `/launch` and `/sso`; GitHub facts captured on create and
  refresh.
- Full gate: `npm run type-check && npm run lint && npm test`.
- Live: roster shows origin/GitHub chips for the four linked accounts; a
  Postmark test bounce lands on a profile; Slack sign-in stamps the profile.

## Follow-ups

None.
