---
status: done
depends: [saml-idp, saml-self-host]
specs:
  - specs/api/saml.md
issues: []
pr: 174
---

# Plan: SAML AuthnStatement + Redirect-binding SSO

## Scope

Close the two conformance gaps that surfaced while preparing to test the IdP
against the real Slack workspace:

1. The assertion emits no `<saml:AuthnStatement>`. The Web Browser SSO profile
   requires at least one and Slack sends a `RequestedAuthnContext`, so this is
   the most likely rejection on first contact.
2. Slack's "Test configuration" 404s: Slack delivers the AuthnRequest over the
   HTTP-Redirect binding (`GET /api/saml/slack/sso?SAMLRequest=<deflate+b64>`),
   which our metadata advertises but the API only registered as `POST`.

In: spec both behaviours, implement, test. Out: any change to NameID /
attribute shape (frozen by [`saml-idp`](saml-idp.md)); echoing the SP's
`RequestedAuthnContext` (deliberately not — see spec); signed AuthnRequests
(Slack doesn't sign; `wantAuthnRequestsSigned` stays false); the still-open
end-to-end verification against the live workspace (#51).

## Implements

- [api/saml.md](../specs/api/saml.md) — `## Identity assertion` →
  `### Authentication statement` (AuthnInstant, SessionIndex, fixed
  `AuthnContextClassRef`, `SessionNotOnOrAfter` omitted); the endpoints table
  and `## GET | POST /api/saml/slack/sso` (both bindings, one flow).

## Approach

- **Legacy check first.** Read the Emergence SAML2 connector laddr used
  (`JarvusInnovations/emergence-saml2` → `Emergence\SAML2\Connector`) to see
  what it emitted: `setSessionIndex(generateId())` and
  `setAuthnContext(SAML2_Constants::AC_PASSWORD)` on a simplesamlphp
  `Assertion`, whose `AuthnInstant` defaults to construction time and whose
  `SessionNotOnOrAfter` is left null. `AC_PASSWORD` is
  `urn:oasis:names:tc:SAML:2.0:ac:classes:Password` (confirmed in
  simplesamlphp/saml2 `Constants.php`). Match that class rather than the
  brief's initial `PasswordProtectedTransport` — continuity with what the
  workspace already accepted beats the more precise label.
- **Template.** Add the AuthnStatement literally to `loginResponseTemplate.context`
  in `apps/api/src/saml/config.ts`, after `</saml:Conditions>` and before
  `{AttributeStatement}`. samlify's built-in template has a bare
  `{AuthnStatement}` slot that its default path blanks; we're on the
  `customTagReplacement` path anyway, so we own the markup and fill three
  placeholders of our own: `{AuthnInstant}`, `{SessionIndex}`,
  `{AuthnContextClassRef}`.
- **Substitutions.** `buildResponseSubstitutions` gains a `sessionIndex` input
  and emits the three tags; `AuthnInstant` reuses the same `now` as
  `IssueInstant`. The route's `buildCustomTagReplacement` mints the
  SessionIndex from the same `generateID` as the Response/Assertion IDs so it
  is fresh and distinct. Signing happens after the callback returns, so the
  statement is inside the signed subtree with no further work.
- **Redirect binding.** Register `GET /api/saml/slack/sso`. Instead of samlify's
  `parseLoginRequest(sp, 'redirect', { query })` plus a binding-aware resume
  cookie, inflate at the edge (`inflateRawSync` → re-base64) into the plain
  form the POST binding carries, then run both methods through a shared
  `handleSpInitiatedSso`. samlify's redirect flow is exactly that inflate
  followed by the same parser (checked in `flow.js`), and the resume cookie's
  `samlRequest` claim keeps one shape. Fold `' '` back to `'+'` in the query
  value before decoding — a sender that leaves base64 `+` unescaped has it
  URL-decoded to a space.
- **Tests** in `apps/api/tests/saml.test.ts`: AuthnStatement position, fixed
  ClassRef, `AuthnInstant` ISO and `<= IssueInstant`, SessionIndex distinct
  from the assertion ID, no `SessionNotOnOrAfter`; cryptographic signature
  verification via `samlify.SamlLib.verifySignature` against the metadata
  endpoint's cert, plus a tamper case; Redirect binding for signed-in,
  anonymous → `/sso/resume`, bad ACS, and non-DEFLATEd payload.

## Validation

- [x] Every issued assertion contains exactly one `AuthnStatement`, after
      `Conditions` and before `AttributeStatement`
- [x] `AuthnContextClassRef` is `urn:oasis:names:tc:SAML:2.0:ac:classes:Password`
      on both IdP-initiated and SP-initiated responses
- [x] `AuthnInstant` parses as ISO-8601 and is `<=` the assertion `IssueInstant`
- [x] `SessionIndex` present, opaque, and not equal to the assertion `ID`;
      `SessionNotOnOrAfter` absent
- [x] Assertion signature verifies against the metadata cert with the
      AuthnStatement present; altering the ClassRef invalidates it
- [x] `GET /api/saml/slack/sso` with a DEFLATEd `SAMLRequest`: signed-in → 200
      auto-submit form with `InResponseTo` + `RelayState`; anonymous → resume
      cookie + 302 `/login`, and `/sso/resume` completes the flow
- [x] `GET /api/saml/slack/sso` with a bad ACS → 422; with a non-DEFLATEd
      payload → 422
- [x] Existing POST-binding tests unchanged and green
- [x] `type-check` + `lint` clean; api suite green (saml.test.ts 18/18; full
      api suite 440/440, no fixture-clone flake this run)
- [ ] Slack "Test configuration" passes against the live workspace

## Risks / unknowns

- **Slack rejecting `Password` vs its requested `PasswordProtectedTransport`.**
  Slack's `RequestedAuthnContext` uses `Comparison="exact"` by default, but the
  legacy connector asserted `Password` against this workspace for years, so the
  check is evidently lenient. If the live test rejects on context, the fix is a
  one-line constant change plus a spec edit — not a redesign.
- **Redirect-binding query decoding.** Fastify's query parser URL-decodes once;
  a compliant sender percent-encodes `+`, `/`, `=` and we get the base64 back
  intact. The space-fold covers the one common non-compliance. A sender that
  double-encodes would still fail to inflate → 422 with a log line.
- **Fixture-clone flake (#171)** on the full api suite is unrelated; re-run the
  file alone if it trips.

## Notes

- **Live-workspace criterion left unchecked.** Requires a Slack admin to run
  "Test configuration" against a deployed build; the code fix for the 404 it
  hit is here, but the pass itself can only be observed in sandbox/prod. Closes
  out under #51 with the rest of the e2e verification.
- **`Password`, not `PasswordProtectedTransport`.** The brief opened with
  `PasswordProtectedTransport` (Slack's default request). Reading the legacy
  connector changed the call: laddr asserted `AC_PASSWORD` against this exact
  workspace with no rejections, so matching it is the lower-risk choice and is
  now the spec'd value. The class is a single exported constant
  (`SLACK_AUTHN_CONTEXT_CLASS_REF`) if the live test disagrees.
- **Legacy `NotBefore` skew.** The legacy connector set `Conditions/@NotBefore`
  to `time() - 30`; ours is `now`. Not changed here — samlify's own default is
  `now`, there's no evidence Slack has trouble with it, and it's out of this
  plan's scope. Worth remembering if the live test reports a `NotBefore`
  clock-skew failure.
- **samlify template ownership.** samlify's built-in login-response template
  has a `{AuthnStatement}` slot, but the default (non-custom) substitution
  blanks it and we're on the `customTagReplacement` path regardless, so the
  statement lives literally in our template with our own placeholder names.
  Do not expect samlify to inject one for you.
- **Redirect-binding normalisation.** `inflateRedirectBindingRequest` folds
  the GET wire form into the POST wire form at the edge; downstream code and
  the resume cookie never learn which binding carried the request. samlify's
  `'redirect'` parser was checked (`flow.js` → `inflateRawSync` then the same
  parse) and deliberately not used so the cookie stays binding-agnostic.
- **Cryptographic signature check in tests.** `samlify.SamlLib.verifySignature`
  with `IdPMetadata(<metadata endpoint body>)` verifies against the exact cert
  the metadata advertises and returns the signed subtree, which is a cheap way
  to assert "X is inside the signature" — reusable for future assertion-shape
  changes.

## Follow-ups

- Tracked as: live Slack "Test configuration" + member sign-in against the
  deployed build — issue [#51](https://github.com/CodeForPhilly/codeforphilly-ng/issues/51)
  (e2e verification against a real workspace) already covers it; this plan
  adds the AuthnStatement/ClassRef and Redirect-binding outcomes to what that
  run should confirm.
