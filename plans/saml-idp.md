---
status: in-progress
depends: [github-oauth]
specs:
  - specs/api/saml.md
issues: []
---

# Plan: SAML IdP for Slack

## Scope

Implement the Slack SAML IdP endpoints. After this plan, members can sign into codeforphilly.slack.com via codeforphilly.org's SSO. The flow preserves the legacy `NameID` format and attribute set, so existing Slack accounts authenticate continuously.

Can run in parallel with [`account-claim`](account-claim.md) — both depend on [`github-oauth`](github-oauth.md) for the underlying session but don't depend on each other.

Out of scope: any non-Slack SAML SP integration.

## Implements

- [api/saml.md](../specs/api/saml.md) — `GET /api/saml/slack/metadata`, `GET /api/saml/slack/launch`, `POST /api/saml/slack/sso`
- The `slackSamlNameId` field on Person (already in [data-model.md](../specs/data-model.md); populated by [`storage-foundation`](storage-foundation.md) for new users at creation time, by [`laddr-import`](laddr-import.md) for migrated users)

## Approach

### Library choice

Use **`samlify`** or **`@node-saml/node-saml`** for SAML XML manipulation + signing + validation. Both are mature. Pick at start; the wrapper interface looks the same either way.

### Cert + key wiring

The deploy already injects `SAML_PRIVATE_KEY` and `SAML_CERTIFICATE` env vars (per [`api-skeleton`](api-skeleton.md)'s env schema). Load at boot.

### IdP metadata (`GET /api/saml/slack/metadata`)

Generates and returns the IdP metadata XML, signed:

- `entityID` = `https://codeforphilly.org/api/saml/slack/metadata`
- `SingleSignOnService` bindings — HTTP-POST (primary) + HTTP-Redirect (secondary)
- `X509Certificate` element with the cert
- Supported `NameIDFormat`: `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`

Slack admin consumes this once during setup; we generally don't re-fetch.

### IdP-initiated SSO (`GET /api/saml/slack/launch`)

1. Require a signed-in session (`requireAuth('user')`) — if anonymous, redirect to `/login?return=<this URL>`
2. Validate `channel` query param against the chatChannel regex
3. Verify the Person is permitted (default: any `user` accountLevel passes; the `samlSlackUserIsPermitted` hook is a static function on a small `apps/api/src/saml/permitted.ts` module)
4. Build the SAML Response:
   - NameID: `{ Format: 'persistent', NameQualifier: <teamHost>, SPNameQualifier: 'https://slack.com', Value: person.slackSamlNameId }`
   - Attributes: `User.Email` (from PrivateProfile), `User.Username` (Person.slug), `first_name`, `last_name`
   - Signed with `SAML_PRIVATE_KEY`
5. Render an auto-submitting HTML form POSTing `SAMLResponse` (+ `RelayState`) to Slack's ACS URL

The auto-submit form is a tiny inline HTML template with a `<form>` that JS auto-submits, plus a fallback button for users with JS disabled.

### SP-initiated SSO (`POST /api/saml/slack/sso`)

1. Parse `SAMLRequest` (decode base64 + inflate)
2. (Optionally validate signature if Slack signs requests; usually no)
3. Verify `AssertionConsumerServiceURL` against Slack's known ACS endpoint(s)
4. If user not signed in: store the `SAMLRequest` + `RelayState` in a short-lived signed cookie, redirect to `/login?return=/api/saml/slack/sso/resume`
5. After login (the SPA hits the resume endpoint with the stored AuthnRequest), proceed as in `/launch`

The resume flow is the tricky part — implemented as `GET /api/saml/slack/sso/resume` that decodes the cookie and continues the assertion build.

### Slack team host config

`SLACK_TEAM_HOST` env var = `codeforphilly.slack.com`. Used as `NameQualifier`. Also used in the `/chat` redirect handler — defer to a shared config module.

### NameID stability check

A boot-time invariant: every Person record's `slackSamlNameId` must be non-null and unique. Logged + alert if any Person is missing it. The laddr-import populates this for migrated users; new Persons get it at creation in `github-oauth`.

### Attribute sourcing

`User.Email` comes from `PrivateProfile.email`. This means a SAML assertion needs both store reads — fine since both are in memory.

## Validation

- [ ] `GET /api/saml/slack/metadata` returns valid SAML 2.0 IdP metadata XML; signature validates with the cert
- [ ] Connect a test Slack workspace using the metadata: SAML SSO setup completes
- [ ] `GET /api/saml/slack/launch` (signed-in user) returns the auto-submitting form posting to Slack's ACS; signed SAMLResponse contains the right NameID + attributes
- [ ] `GET /api/saml/slack/launch?channel=phlask` lands the user in #phlask after Slack consumes the assertion
- [ ] `POST /api/saml/slack/sso` (signed-in user, with a real Slack AuthnRequest) returns the signed Response
- [ ] `POST /api/saml/slack/sso` (anonymous) stores the AuthnRequest in a cookie, redirects to /login, resumes correctly after login
- [ ] Anonymous user hits `/launch` → redirected to `/login?return=…` → after login, redirected back → SAML assertion issued
- [ ] NameID for a *previously-Slack-authenticating* user matches their pre-cutover NameID exactly (verify against captured legacy assertions from staging)
- [ ] Cert rotation procedure documented in `docs/operations/update-saml2-certificate.md` (parallels the legacy doc)
- [ ] Tests: mock Slack ACS endpoint; verify SAMLResponse structure + signature validates

## Risks / unknowns

- **Capture a legacy assertion before cutover.** The single highest-stakes thing in this plan is "v1 NameID matches laddr-emitted NameID for existing users." Verify by capturing a real assertion from the legacy site during dry-run and diffing against ours.
- **SP-initiated flow's cookie-resume.** Has to survive an OAuth round-trip (user gets sent to GitHub, comes back, then we resume the SAML). The cookie's max-age covers it (10 min), but verify in staging.
- **Slack workspace admin coordination.** Updating the IdP cert + endpoint URLs in Slack requires admin action. Coordinate with whoever holds the keys.
- **Cert + key rotation.** Document the procedure (per legacy docs). The 3-year cadence means we'll do this once before another full rewrite.

## Notes
