/**
 * SAML IdP/SP entity construction.
 *
 * Slack publishes its expected ACS endpoint as a URL per workspace
 * (`https://<team>.slack.com/sso/saml`). We build a tiny ad-hoc SP entity to
 * point samlify at, since Slack doesn't publish SP metadata XML we could fetch
 * at boot.
 *
 * The IdP entity binds our `entityID`, the published SSO endpoints, and the
 * NameID + attribute statement template that produces the assertion shape
 * required by specs/api/saml.md.
 */
import * as samlify from 'samlify';

const { IdentityProvider, ServiceProvider, Constants, SamlLib, setSchemaValidator } = samlify;

// samlify requires a schema validator be configured at module load. We don't
// rely on the validator's correctness for security — request signature
// verification is opt-in (Slack doesn't sign AuthnRequests by default) and
// AssertionConsumerServiceURL is allow-listed before any assertion is built.
// The no-op validator keeps samlify happy without pulling in the heavy
// `@authenio/samlify-xsd-schema-validator` java dependency.
const NAMEID_FORMAT_PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';

let schemaValidatorConfigured = false;
function ensureSchemaValidator(): void {
  if (schemaValidatorConfigured) return;
  setSchemaValidator({
    validate: async () => 'skipped',
  });
  schemaValidatorConfigured = true;
}

export interface SamlIdpSettings {
  /** PEM-encoded RSA private key for signing assertions. */
  readonly privateKey: string;
  /** PEM-encoded X.509 certificate (the public half). */
  readonly certificate: string;
  /** The IdP entity ID — also the metadata URL. */
  readonly entityId: string;
  /** The IdP SSO POST binding location (the /launch endpoint). */
  readonly ssoLoginPostUrl: string;
  /** The IdP SSO Redirect binding location. */
  readonly ssoLoginRedirectUrl: string;
  /** Slack team host (e.g. `codeforphilly.slack.com`). */
  readonly slackTeamHost: string;
}

export interface SlackSamlEntities {
  readonly idp: ReturnType<typeof IdentityProvider>;
  readonly sp: ReturnType<typeof ServiceProvider>;
  readonly slackTeamHost: string;
  readonly acsUrl: string;
  readonly metadataXml: string;
  readonly entityId: string;
}

/**
 * Slack assertion attribute set per specs/api/saml.md.
 */
export interface SlackAssertionUser {
  readonly nameId: string;
  readonly email: string;
  readonly username: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface BuildResponseSubstitutionsOptions {
  readonly user: SlackAssertionUser;
  readonly slackTeamHost: string;
  readonly issuerEntityId: string;
  readonly inResponseTo: string;
  /** RFC3339 timestamp (current time) — passed in so tests can pin it. */
  readonly nowIso?: string;
}

/**
 * The tag-substitution map handed to `samlify.SamlLib.replaceTagsByValue` to
 * realise the LoginResponse template at request time.
 *
 * Constructed once per response and shared with the IdP-built attribute
 * statement (see comment in `buildSlackSamlEntities`).
 */
export function buildResponseSubstitutions(
  opts: BuildResponseSubstitutionsOptions,
): Record<string, string> {
  const now = opts.nowIso ?? new Date().toISOString();
  const fiveMinutesLater = new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
  const acs = slackAcsUrl(opts.slackTeamHost);
  return {
    // Note: ID + AssertionID are set by samlify's customTagReplacement caller
    // (via the generateID hook). We provide everything else.
    Destination: acs,
    SubjectRecipient: acs,
    Audience: 'https://slack.com',
    Issuer: opts.issuerEntityId,
    IssueInstant: now,
    StatusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
    ConditionsNotBefore: now,
    ConditionsNotOnOrAfter: fiveMinutesLater,
    SubjectConfirmationDataNotOnOrAfter: fiveMinutesLater,
    NameIDFormat: NAMEID_FORMAT_PERSISTENT,
    NameQualifier: opts.slackTeamHost,
    SPNameQualifier: 'https://slack.com',
    NameID: opts.user.nameId,
    InResponseTo: opts.inResponseTo,
    // samlify's `attributeStatementBuilder` derives placeholder names from
    // each attribute's `valueTag` via `'attr' + camelCase + first-upper`, so
    // `valueTag: 'email'` → `{attrEmail}`, `valueTag: 'firstName'` →
    // `{attrFirstName}` (note: the first letter of the camel-cased tag is
    // uppercased, the rest is preserved as-is). See libsaml.js `tagging`.
    attrEmail: opts.user.email,
    attrUsername: opts.user.username,
    attrFirstName: opts.user.firstName,
    attrLastName: opts.user.lastName,
  };
}

/**
 * Expose samlify's replaceTagsByValue so callers can build the final response
 * XML inside their customTagReplacement callback.
 */
export function replaceTagsByValue(
  rawXml: string,
  tags: Record<string, string>,
): string {
  return SamlLib.replaceTagsByValue(rawXml, tags);
}

/**
 * Slack's ACS URL pattern for SAML SSO is documented at
 * https://slack.com/help/articles/203772216 — every workspace's IdP-initiated
 * endpoint is `https://<team>.slack.com/sso/saml`. SP-initiated AuthnRequests
 * arrive carrying an `AssertionConsumerServiceURL` that we must validate
 * against this exact value.
 */
export function slackAcsUrl(slackTeamHost: string): string {
  return `https://${slackTeamHost}/sso/saml`;
}

/**
 * Slack's SP entity ID is its workspace ACS URL. We construct a stub SP to
 * satisfy samlify's IdP→SP coupling for response building.
 */
function buildSlackSpEntity(slackTeamHost: string): ReturnType<typeof ServiceProvider> {
  const acs = slackAcsUrl(slackTeamHost);
  return ServiceProvider({
    entityID: acs,
    authnRequestsSigned: false,
    wantAssertionsSigned: true,
    wantMessageSigned: false,
    assertionConsumerService: [
      {
        Binding: Constants.namespace.binding.post,
        Location: acs,
      },
    ],
    nameIDFormat: [NAMEID_FORMAT_PERSISTENT],
  });
}

/**
 * Build the IdP entity and metadata XML.
 *
 * The login response template's `attributes` declares the four attributes the
 * Slack assertion must carry (per specs/api/saml.md). At response-build time
 * we hand samlify a `user` object whose keys match `valueTag`, which samlify
 * substitutes verbatim.
 */
export function buildSlackSamlEntities(settings: SamlIdpSettings): SlackSamlEntities {
  ensureSchemaValidator();

  const idp = IdentityProvider({
    entityID: settings.entityId,
    privateKey: settings.privateKey,
    signingCert: settings.certificate,
    isAssertionEncrypted: false,
    wantAuthnRequestsSigned: false,
    nameIDFormat: [NAMEID_FORMAT_PERSISTENT],
    singleSignOnService: [
      {
        Binding: Constants.namespace.binding.post,
        Location: settings.ssoLoginPostUrl,
        isDefault: true,
      },
      {
        Binding: Constants.namespace.binding.redirect,
        Location: settings.ssoLoginRedirectUrl,
      },
    ],
    loginResponseTemplate: {
      // samlify substitutes {AttributeStatement} from the configured attribute
      // list; the rest of the template comes from the library's built-in
      // response template.
      context:
        '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{ID}" Version="2.0" IssueInstant="{IssueInstant}" Destination="{Destination}" InResponseTo="{InResponseTo}"><saml:Issuer>{Issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="{StatusCode}"/></samlp:Status><saml:Assertion ID="{AssertionID}" Version="2.0" IssueInstant="{IssueInstant}"><saml:Issuer>{Issuer}</saml:Issuer><saml:Subject><saml:NameID Format="{NameIDFormat}" NameQualifier="{NameQualifier}" SPNameQualifier="{SPNameQualifier}">{NameID}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="{SubjectConfirmationDataNotOnOrAfter}" Recipient="{SubjectRecipient}" InResponseTo="{InResponseTo}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="{ConditionsNotBefore}" NotOnOrAfter="{ConditionsNotOnOrAfter}"><saml:AudienceRestriction><saml:Audience>{Audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>{AttributeStatement}</saml:Assertion></samlp:Response>',
      attributes: [
        {
          name: 'User.Email',
          nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
          valueXsiType: 'xs:string',
          valueTag: 'email',
        },
        {
          name: 'User.Username',
          nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
          valueXsiType: 'xs:string',
          valueTag: 'username',
        },
        {
          name: 'first_name',
          nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
          valueXsiType: 'xs:string',
          valueTag: 'firstName',
        },
        {
          name: 'last_name',
          nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
          valueXsiType: 'xs:string',
          valueTag: 'lastName',
        },
      ],
    },
  });

  const sp = buildSlackSpEntity(settings.slackTeamHost);

  return {
    idp,
    sp,
    slackTeamHost: settings.slackTeamHost,
    acsUrl: slackAcsUrl(settings.slackTeamHost),
    metadataXml: idp.getMetadata(),
    entityId: settings.entityId,
  };
}
