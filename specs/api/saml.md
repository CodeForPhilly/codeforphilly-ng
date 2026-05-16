# API: SAML Identity Provider (for Slack)

The site is a **SAML 2.0 Identity Provider** for Code for Philly's Slack workspace. This continues the long-standing arrangement where members sign in to Slack via codeforphilly.org. The legacy laddr code lives in [`JarvusInnovations/emergence-slack`](https://github.com/JarvusInnovations/emergence-slack/blob/main/php-classes/Emergence/Slack/Connector.php); the v1 design preserves its NameID format so existing Slack accounts stay continuously valid through the migration.

GitHub OAuth is how a member proves identity to the new site. SAML is how the site asserts that identity to Slack. The two flows compose: a member's Slack sign-in triggers our SAML flow, which requires an active GitHub-OAuth-backed session.

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/saml/slack/metadata` | public | IdP metadata XML for Slack to consume |
| `GET` | `/api/saml/slack/launch` | user | IdP-initiated SSO — site → Slack |
| `POST` | `/api/saml/slack/sso` | user | SP-initiated SSO callback — handles AuthnRequest from Slack |

For the existing `/chat` redirect that Slack-launches members into channels, see [screens/chat.md](../screens/chat.md). The SAML endpoints live under `/api/saml/slack/*` because the v1 design leaves room for additional SAML SP integrations later.

## Identity assertion

Per [emergence-slack's Connector.php](https://github.com/JarvusInnovations/emergence-slack/blob/main/php-classes/Emergence/Slack/Connector.php), the legacy laddr code asserts:

```text
NameID:
  Format          urn:oasis:names:tc:SAML:2.0:nameid-format:persistent
  NameQualifier   <teamHost>                                        e.g., codeforphilly.slack.com
  SPNameQualifier https://slack.com
  Value           <Person.Username>                                  the user's username, NOT email

Attributes:
  User.Email      <Person.Email>
  User.Username   <Person.Username>
  first_name      <Person.FirstName>
  last_name       <Person.LastName>
```

**v1 preserves every one of these field values and the NameID format**, so existing Slack accounts continue to authenticate against the same identifier they always have.

The NameID `Value` is `Person.slackSamlNameId` (per [data-model.md](../data-model.md)) — populated from `slug` at Person creation, **immutable after**, so slug renames don't invalidate the user's Slack identity. The migration script populates `slackSamlNameId = slug` for every imported Person at cutover.

The attribute values come from:

- `User.Email` → `PrivateProfile.email` (current GitHub primary verified email)
- `User.Username` → `Person.slug`
- `first_name` → `Person.firstName`
- `last_name` → `Person.lastName`

## GET /api/saml/slack/metadata

Returns the IdP's SAML metadata XML, signed with the IdP cert. Slack consumes this once during admin setup; we generally don't re-fetch.

### Response — 200

```http
Content-Type: application/samlmetadata+xml; charset=utf-8

<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" ...>
  ...
</EntityDescriptor>
```

The metadata declares:

- `entityID` — our IdP entity ID, e.g., `https://codeforphilly.org/api/saml/slack/metadata`
- `SingleSignOnService` binding(s) — `urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST` (for SP-initiated) and `urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect`
- `X509Certificate` — the IdP cert from `SAML_CERTIFICATE`
- NameID formats supported: `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`

## GET /api/saml/slack/launch

**IdP-initiated sign-in** — the member is on our site and wants to sign into Slack.

### Query parameters

| Param | Required | Notes |
| ----- | -------- | ----- |
| `channel` | no | Slack channel name to land in after sign-in (e.g., `general`, `phlask`). Validated against `^[a-z0-9][a-z0-9_-]{0,80}$`. |
| `redir` | no | Slack post-login path (alternative to `channel`). Default: workspace home. |

### Behavior

1. Require a signed-in session. If not signed in → redirect to `/login?return=<encoded current URL>`.
2. Validate the member is permitted (default: any `user` accountLevel; configurable via the same `userIsPermitted` hook the legacy code provided).
3. Build a SAML Response containing the NameID + attributes for the current Person.
4. Sign the Response with the IdP private key.
5. Redirect the browser to Slack's ACS URL via an HTML auto-submitting form (HTTP-POST binding), carrying:
   - `SAMLResponse` (base64-encoded signed XML)
   - `RelayState` — the channel/redir path so Slack lands the user in the right place

The destination URL inside the Response includes the `redir` so Slack's POST endpoint sees it.

### Errors

- `401 unauthenticated` — no session (redirect to /login)
- `403 forbidden` with `error.code = "saml_not_permitted"` — Person doesn't meet the membership requirement
- `400 validation_failed` — bad `channel` format
- `500 internal_error` with `error.code = "saml_signing_failed"` — IdP cert/key misconfiguration

## POST /api/saml/slack/sso

**SP-initiated sign-in** — Slack received a request from a member who wants to sign in, sent us a SAML AuthnRequest. We complete authentication and return a SAML Response.

### Request body

`application/x-www-form-urlencoded`:

| Field | Required | Notes |
| ----- | -------- | ----- |
| `SAMLRequest` | yes | base64-encoded SAML AuthnRequest XML |
| `RelayState` | no | opaque value Slack wants us to echo back |

### Behavior

1. Decode + parse the AuthnRequest. Validate signature if Slack signs requests (configurable; usually no for Slack).
2. Require a signed-in session. If not → store the AuthnRequest in a short-lived signed cookie, redirect to `/login?return=/api/saml/slack/sso?resume=1`. After login the user comes back here and the AuthnRequest replays from the cookie.
3. Resolve the AuthnRequest's `AssertionConsumerServiceURL` against Slack's documented ACS endpoint(s) — only Slack's ACS is accepted.
4. Build + sign a SAML Response as in `/launch`.
5. POST back to Slack's ACS via the auto-submitting form, including `RelayState`.

### Errors

- `400 validation_failed` with code `saml_request_invalid` — malformed AuthnRequest or unrecognized ACS URL
- `401 unauthenticated` — no session (with resume-cookie flow as above)
- `403 forbidden` with `error.code = "saml_not_permitted"`

## Account-level hook

The legacy `IdentityConsumerTrait` exposes a `userIsPermitted` static — code for Philly used the default ("any user accountLevel"). v1 preserves that hook conceptually:

- Default: any `user` accountLevel passes
- Configurable per-consumer via a static `samlSlackUserIsPermitted: (person: Person) => boolean` predicate the deploy can override (rarely needed)

There's no v1 plan to vary this — keeping the hook just preserves the legacy escape valve.

## Cert + key rotation

The cert + private key are env-injected:

| Env var | Purpose |
| ------- | ------- |
| `SAML_PRIVATE_KEY` | PEM-encoded RSA private key for signing assertions |
| `SAML_CERTIFICATE` | PEM-encoded X.509 cert (the public half) |

Slack's admin panel holds the matching public cert. Rotation is a coordinated procedure (per the legacy `docs/operations/update-saml2-certificate.md`):

1. Generate new key + cert
2. Update Slack's admin UI with the new public cert
3. Update the API's `SAML_PRIVATE_KEY` / `SAML_CERTIFICATE` secrets
4. Restart the API

Plan to rotate every 3 years before cert expiry; track in operational runbooks.

## Cutover continuity

Existing Slack accounts are tied to `NameID.Value = <laddr Username>`. Because the rewrite preserves slugs (per [behaviors/slug-handles.md](../behaviors/slug-handles.md)) AND populates `slackSamlNameId` from slug at migration time, every existing Slack account continues to authenticate the same way on cutover day.

After cutover, slug renames don't break Slack identity (immutable `slackSamlNameId`). New Persons created post-cutover get `slackSamlNameId` populated at creation; their Slack-side identity binds on first Slack sign-in.

## Coordinates with

- [api/auth.md](auth.md) — GitHub OAuth flow that proves identity to our IdP
- [data-model.md](../data-model.md) — `Person.slackSamlNameId`, `PrivateProfile.email`
- [behaviors/authorization.md](../behaviors/authorization.md) — session/JWT model
- [screens/chat.md](../screens/chat.md) — the `/chat` redirect that launches Slack
- [behaviors/account-migration.md](../behaviors/account-migration.md) — preserving identity continuity at cutover
