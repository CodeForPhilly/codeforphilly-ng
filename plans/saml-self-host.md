---
status: in-progress
depends: [saml-idp]
specs:
  - specs/api/saml.md
  - specs/architecture.md
issues: []
---

# Plan: SAML IdP identity and endpoint hosts

## Scope

Fix the SAML IdP so that the metadata `entityID`, the assertion `Issuer`, and
the `SingleSignOnService` endpoint URLs are built from our own settings rather
than from `SLACK_TEAM_HOST`. Today the live metadata at
`https://next.codeforphilly.org/api/saml/slack/metadata` advertises
`entityID="https://codeforphilly.slack.com/api/saml/slack/metadata"` and
`Location="https://codeforphilly.slack.com/api/saml/slack/sso"` — both on
Slack's host. This closes the "entityID host source" follow-up left open by
[`saml-idp`](saml-idp.md).

In scope:

- A new optional `SAML_ENTITY_ID` env var (default
  `https://codeforphilly.org/api/saml/slack/metadata`) that is the single
  source for both the metadata `entityID` and every assertion `<Issuer>`.
- SSO endpoint `Location`s built from `CFP_SITE_HOST`.
- `SLACK_TEAM_HOST` retains exactly its Slack-side roles: ACS URL, NameID
  `NameQualifier`, `/launch` redirect target.
- Spec + operator docs + `.env.example` describing the three-way split.
- Tests covering the default entity ID, the `CFP_SITE_HOST`-driven endpoint
  URL, and the entity ID staying put when `CFP_SITE_HOST` changes.

Out of scope: re-registering the IdP with Slack (operator action, not code);
any change to NameID or the attribute set.

## Implements

- [api/saml.md](../specs/api/saml.md) — the new "IdP identity and hosts"
  section: `entityID` = `SAML_ENTITY_ID`; `SingleSignOnService/@Location` =
  `https://<CFP_SITE_HOST>/api/saml/slack/sso`; `Issuer` = `entityID`.
- [architecture.md](../specs/architecture.md) — env table rows for
  `SAML_ENTITY_ID`, `SLACK_TEAM_HOST`, `CFP_SITE_HOST`.

## Approach

1. **Spec first.** Add the "IdP identity and hosts" section to
   `specs/api/saml.md` stating the three sources and the stability rule for
   the entity ID; add `SAML_ENTITY_ID` to the env tables in the spec,
   `specs/architecture.md`, `docs/operations/deploy.md`,
   `docs/operations/secrets.md`, and `.env.example`.
2. **Env.** Add `SAML_ENTITY_ID` to `EnvSchema` (zod) and the mirrored JSON
   schema in `apps/api/src/env.ts`, defaulting to
   `https://codeforphilly.org/api/saml/slack/metadata`.
3. **Route.** In `getSamlContext` (`apps/api/src/routes/saml.ts`) build the
   `SamlIdpSettings` as:
   - `entityId: cfg.SAML_ENTITY_ID`
   - `ssoLoginPostUrl` / `ssoLoginRedirectUrl`:
     `https://${cfg.CFP_SITE_HOST}/api/saml/slack/sso`
   - `slackTeamHost: cfg.SLACK_TEAM_HOST` (unchanged)
   Drop the `issuerHost` derivation and its misleading comment.
4. **Config.** `apps/api/src/saml/config.ts` already threads
   `settings.entityId` into both the samlify `IdentityProvider({ entityID })`
   (→ metadata) and `SlackSamlEntities.entityId`, which the route passes as
   `issuerEntityId` into `buildResponseSubstitutions` (→ `{Issuer}` on both
   the Response and the Assertion). No change needed there beyond doc
   comments; verify rather than assume.
5. **Tests.** Update `apps/api/tests/saml.test.ts`: metadata `entityID`
   equals the default `SAML_ENTITY_ID`; SSO `Location`s use `CFP_SITE_HOST`;
   assertion `Issuer` (both Response and Assertion) equals the entity ID; a
   second app booted with `CFP_SITE_HOST=next.example.org` gets `Location`
   on that host while `entityID` stays the default; an explicit
   `SAML_ENTITY_ID` override flows through to both metadata and `Issuer`.

## Validation

- [ ] `GET /api/saml/slack/metadata` `entityID` is
      `https://codeforphilly.org/api/saml/slack/metadata` with no
      `SAML_ENTITY_ID` set, regardless of `SLACK_TEAM_HOST` / `CFP_SITE_HOST`.
- [ ] Both `SingleSignOnService/@Location` values are
      `https://<CFP_SITE_HOST>/api/saml/slack/sso`; with
      `CFP_SITE_HOST=next.example.org` they use that host.
- [ ] `<saml:Issuer>` on the Response and the Assertion equal the metadata
      `entityID`, including when `SAML_ENTITY_ID` is overridden.
- [ ] ACS URL, form action, `NameQualifier`, and `/launch` redirect still use
      `SLACK_TEAM_HOST` (existing tests keep passing).
- [ ] `SLACK_TEAM_HOST` no longer appears in any IdP-side URL (grep the route).
- [ ] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Slack already has the wrong entity ID on file.** If the `next.`
  deployment's metadata was uploaded to Slack, Slack stored
  `https://codeforphilly.slack.com/api/saml/slack/metadata` as the IdP
  issuer. After this ships, assertions carry the correct issuer and Slack
  will reject them until its SAML config is re-synced from the metadata URL.
  Operator coordination, noted in Follow-ups.
- **Cutover host flip.** `Location` changes from `next.codeforphilly.org` to
  `codeforphilly.org` at cutover; Slack's IdP config needs a metadata refresh
  then too (endpoint URLs only — the entity ID is untouched, so the trust
  relationship survives).

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
