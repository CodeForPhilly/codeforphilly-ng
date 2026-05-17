/**
 * SAML IdP endpoints for the Slack workspace integration.
 *
 * Implements specs/api/saml.md:
 *   GET  /api/saml/slack/metadata
 *   GET  /api/saml/slack/launch
 *   POST /api/saml/slack/sso
 *   GET  /api/saml/slack/sso/resume  (sign-in continuation)
 *
 * Cert + key load lazily — endpoints return 500 saml_signing_failed if the
 * environment is missing them. Routes are mounted regardless so the
 * metadata URL is always discoverable.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { ForbiddenError, UnauthenticatedError, ApiValidationError } from '../lib/errors.js';
import { errorResponse } from '../lib/response.js';
import {
  buildResponseSubstitutions,
  buildSlackSamlEntities,
  replaceTagsByValue,
  slackAcsUrl,
  type SlackAssertionUser,
  type SlackSamlEntities,
} from '../saml/config.js';
import { defaultSamlSlackUserIsPermitted } from '../saml/permitted.js';
import { signSamlResume, verifySamlResume } from '../saml/resume-cookie.js';
import type { Person, PrivateProfile } from '@cfp/shared/schemas';

const CHAT_CHANNEL_REGEX = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const RESUME_COOKIE = 'cfp_saml_resume';
const RESUME_COOKIE_TTL_SECONDS = 10 * 60;

/**
 * SAML ID values must start with an XML NCName character — `_` followed by
 * hex is the standard convention (matches samlify's default `generateID`).
 */
function cryptoRandomId(): string {
  return randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSecure(nodeEnv: string): boolean {
  return nodeEnv === 'production';
}

function safeReturnPath(input: string | undefined | null): string {
  if (!input || typeof input !== 'string') return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

function selfUrl(request: FastifyRequest): string {
  const protocol = request.headers['x-forwarded-proto']
    ? String(request.headers['x-forwarded-proto']).split(',')[0]?.trim() ?? 'http'
    : request.protocol;
  const host = request.headers['x-forwarded-host']
    ? String(request.headers['x-forwarded-host']).split(',')[0]?.trim() ?? request.hostname
    : request.hostname;
  return `${protocol}://${host}${request.url}`;
}

function originBase(request: FastifyRequest): string {
  const protocol = request.headers['x-forwarded-proto']
    ? String(request.headers['x-forwarded-proto']).split(',')[0]?.trim() ?? 'http'
    : request.protocol;
  const host = request.headers['x-forwarded-host']
    ? String(request.headers['x-forwarded-host']).split(',')[0]?.trim() ?? request.hostname
    : request.hostname;
  return `${protocol}://${host}`;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the HTTP-POST binding auto-submit form per saml-bindings §3.5.4.
 * Includes a fallback button for browsers with JS disabled.
 */
function renderPostForm(opts: {
  readonly actionUrl: string;
  readonly samlResponse: string;
  readonly relayState?: string;
}): string {
  const hiddenFields: string[] = [
    `<input type="hidden" name="SAMLResponse" value="${htmlEscape(opts.samlResponse)}"/>`,
  ];
  if (opts.relayState !== undefined && opts.relayState !== '') {
    hiddenFields.push(
      `<input type="hidden" name="RelayState" value="${htmlEscape(opts.relayState)}"/>`,
    );
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing into Slack</title></head>
<body onload="document.forms[0].submit()">
<noscript><p>JavaScript is disabled. Click the button to continue.</p></noscript>
<form method="post" action="${htmlEscape(opts.actionUrl)}">
${hiddenFields.join('\n')}
<noscript><button type="submit">Continue</button></noscript>
</form>
</body></html>`;
}

interface SamlContext {
  readonly entities: SlackSamlEntities;
}

/**
 * Lazy SAML entity construction — built once at first use rather than at app
 * boot, so missing cert/key only fails the SAML endpoints (not the whole
 * process boot). The token check on every call keeps the lookup cheap.
 */
function getSamlContext(fastify: FastifyInstance): SamlContext {
  const cached = (fastify as FastifyInstance & { _samlCtx?: SamlContext })._samlCtx;
  if (cached) return cached;

  const cfg = fastify.config;
  if (!cfg.SAML_PRIVATE_KEY || !cfg.SAML_CERTIFICATE) {
    throw new ApiValidationError('SAML IdP is not configured');
  }

  const base = `https://${cfg.SLACK_TEAM_HOST}`.replace('https://', '');
  const issuerHost = base;
  // Fallback to the team host for the metadata entity ID if we can't see
  // the inbound request origin. Per spec the entityID is our own URL —
  // we'll prefer the request origin when building responses.
  const ctx: SamlContext = {
    entities: buildSlackSamlEntities({
      privateKey: cfg.SAML_PRIVATE_KEY,
      certificate: cfg.SAML_CERTIFICATE,
      entityId: `https://${issuerHost}/api/saml/slack/metadata`,
      ssoLoginPostUrl: `https://${issuerHost}/api/saml/slack/sso`,
      ssoLoginRedirectUrl: `https://${issuerHost}/api/saml/slack/sso`,
      slackTeamHost: cfg.SLACK_TEAM_HOST,
    }),
  };

  (fastify as FastifyInstance & { _samlCtx?: SamlContext })._samlCtx = ctx;
  return ctx;
}

/**
 * Build the per-request assertion user from a signed-in Person + their private
 * profile. The hard invariant — `slackSamlNameId` is non-null — is enforced
 * here so the SAML pipeline only sees a fully-populated user.
 */
function buildAssertionUser(opts: {
  readonly person: Person;
  readonly profile: PrivateProfile;
}): SlackAssertionUser {
  const { person, profile } = opts;
  if (!person.slackSamlNameId) {
    throw new ApiValidationError(
      'Person is missing slackSamlNameId; SAML SSO cannot proceed',
    );
  }
  return {
    nameId: person.slackSamlNameId,
    email: profile.email,
    username: person.slug,
    firstName: person.firstName ?? '',
    lastName: person.lastName ?? '',
  };
}

/**
 * Build the `customTagReplacement` callback for samlify's createLoginResponse.
 *
 * samlify's default substitution forces `NameID = user.email` and ignores the
 * caller-supplied `loginResponseTemplate.context` unless this callback is
 * provided. We use the callback to:
 *
 *  - drop the right NameID (slackSamlNameId, not email) into the assertion
 *  - fill in NameQualifier / SPNameQualifier (samlify's default skips both)
 *  - substitute the per-attribute placeholder tags built by samlify's
 *    `attributeStatementBuilder` (e.g. `{attrEmail}`, `{attrUsername}`).
 */
function buildCustomTagReplacement(opts: {
  readonly user: SlackAssertionUser;
  readonly slackTeamHost: string;
  readonly issuerEntityId: string;
  readonly inResponseTo: string;
  readonly generateID: () => string;
}): (template: string) => { id: string; context: string } {
  return (template) => {
    const id = opts.generateID();
    const assertionId = opts.generateID();
    const subs = buildResponseSubstitutions({
      user: opts.user,
      slackTeamHost: opts.slackTeamHost,
      issuerEntityId: opts.issuerEntityId,
      inResponseTo: opts.inResponseTo,
    });
    const fullSubs: Record<string, string> = {
      ID: id,
      AssertionID: assertionId,
      ...subs,
    };
    return { id, context: replaceTagsByValue(template, fullSubs) };
  };
}

/**
 * Reject responses that would target an ACS we don't recognise. We treat the
 * configured `<team>.slack.com/sso/saml` URL as the only valid destination.
 */
function assertAcsAllowed(acsUrl: string, slackTeamHost: string): void {
  const expected = slackAcsUrl(slackTeamHost);
  if (acsUrl !== expected) {
    throw new ApiValidationError(
      `Unrecognised AssertionConsumerServiceURL: ${acsUrl}`,
      { AssertionConsumerServiceURL: 'must match Slack ACS endpoint' },
    );
  }
}

async function loadPersonAndProfile(
  fastify: FastifyInstance,
  personId: string,
): Promise<{ person: Person; profile: PrivateProfile }> {
  const person = (await fastify.store.public.people.queryFirst({ id: personId })) as
    | Person
    | undefined;
  if (!person) {
    throw new UnauthenticatedError('Person not found', 'unauthenticated');
  }
  if (!defaultSamlSlackUserIsPermitted(person)) {
    throw new ForbiddenError('Not permitted to access Slack', 'saml_not_permitted');
  }
  const profile = await fastify.store.private.getProfile(person.id);
  if (!profile) {
    // A signed-in Person without a private profile shouldn't happen — every
    // sign-in path provisions one. Treat it as a permission gap.
    throw new ForbiddenError(
      'Private profile missing for signed-in user',
      'saml_not_permitted',
    );
  }
  return { person, profile };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function samlRoutes(fastify: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/saml/slack/metadata
  // -------------------------------------------------------------------------

  fastify.get(
    '/api/saml/slack/metadata',
    {
      schema: {
        tags: ['saml'],
        summary: 'Slack IdP metadata XML',
        description:
          'Returns the signed SAML 2.0 IdP metadata XML for Slack to consume during admin setup.',
      },
    },
    async (request, reply) => {
      const cfg = fastify.config;
      if (!cfg.SAML_PRIVATE_KEY || !cfg.SAML_CERTIFICATE) {
        return reply.code(500).send(
          errorResponse(
            'saml_signing_failed',
            'SAML IdP is not configured',
            (request as FastifyRequest & { traceId?: string }).traceId,
          ),
        );
      }
      const { entities } = getSamlContext(fastify);
      return reply
        .header('Content-Type', 'application/samlmetadata+xml; charset=utf-8')
        .send(entities.metadataXml);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/saml/slack/launch  — IdP-initiated SSO
  // -------------------------------------------------------------------------

  fastify.get(
    '/api/saml/slack/launch',
    {
      schema: {
        tags: ['saml'],
        summary: 'IdP-initiated Slack sign-in',
        querystring: {
          type: 'object',
          properties: {
            channel: { type: 'string' },
            redir: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const cfg = fastify.config;

      // Anonymous → bounce through /login preserving the current URL.
      if (!request.session.personId) {
        const here = selfUrl(request);
        return reply.redirect(`/login?return=${encodeURIComponent(here)}`);
      }

      const query = request.query as { channel?: string; redir?: string };
      if (query.channel !== undefined && query.channel !== '') {
        if (!CHAT_CHANNEL_REGEX.test(query.channel)) {
          throw new ApiValidationError('Invalid channel name', { channel: 'invalid format' });
        }
      }

      const { entities } = getSamlContext(fastify);
      const { person, profile } = await loadPersonAndProfile(fastify, request.session.personId);

      const user = buildAssertionUser({ person, profile });

      const customTagReplacement = buildCustomTagReplacement({
        user,
        slackTeamHost: cfg.SLACK_TEAM_HOST,
        issuerEntityId: entities.entityId,
        inResponseTo: '',
        generateID: () => `_${cryptoRandomId()}`,
      });

      // IdP-initiated flow — empty extract per saml-profiles §4.1.5 (unsolicited
      // responses omit InResponseTo).
      const bindingCtx = await entities.idp.createLoginResponse(
        entities.sp,
        { extract: {} },
        'post',
        // samlify normally reads NameID from `user.email`; we feed it the right
        // value through the customTagReplacement callback below so this `user`
        // bag is unused on the hot path.
        {},
        { relayState: query.redir ?? query.channel ?? '', customTagReplacement },
      );

      // PostBindingContext.context holds the base64-encoded signed Response.
      const samlResponse = bindingCtx.context;
      const relayState = 'relayState' in bindingCtx ? bindingCtx.relayState : query.redir;
      const actionUrl =
        'entityEndpoint' in bindingCtx && typeof bindingCtx.entityEndpoint === 'string'
          ? bindingCtx.entityEndpoint
          : entities.acsUrl;

      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(
          renderPostForm({
            actionUrl,
            samlResponse,
            relayState: relayState ?? undefined,
          }),
        );
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/saml/slack/sso  — SP-initiated SSO
  // -------------------------------------------------------------------------

  fastify.post(
    '/api/saml/slack/sso',
    {
      schema: {
        tags: ['saml'],
        summary: 'SP-initiated Slack sign-in (AuthnRequest)',
        body: {
          type: 'object',
          properties: {
            SAMLRequest: { type: 'string' },
            RelayState: { type: 'string' },
          },
          required: ['SAMLRequest'],
        },
      },
    },
    async (request, reply) => {
      const cfg = fastify.config;
      if (!cfg.SAML_PRIVATE_KEY || !cfg.SAML_CERTIFICATE) {
        return reply.code(500).send(
          errorResponse(
            'saml_signing_failed',
            'SAML IdP is not configured',
            (request as FastifyRequest & { traceId?: string }).traceId,
          ),
        );
      }

      const body = request.body as { SAMLRequest?: string; RelayState?: string };
      const samlRequestB64 = body.SAMLRequest ?? '';
      const relayState = body.RelayState ?? '';
      if (!samlRequestB64) {
        throw new ApiValidationError('SAMLRequest is required', {
          SAMLRequest: 'required',
        });
      }

      const { entities } = getSamlContext(fastify);

      // Parse the AuthnRequest to extract its ID + AssertionConsumerServiceURL.
      let parsed: Awaited<ReturnType<typeof entities.idp.parseLoginRequest>>;
      try {
        parsed = await entities.idp.parseLoginRequest(entities.sp, 'post', {
          body: { SAMLRequest: samlRequestB64 },
        });
      } catch (err) {
        fastify.log.warn({ err }, 'SAML AuthnRequest parse failed');
        throw new ApiValidationError('Malformed SAMLRequest', {
          SAMLRequest: 'parse failed',
        });
      }

      const extract = parsed.extract as {
        request?: { id?: string; assertionConsumerServiceUrl?: string };
      };
      const acsUrl =
        extract.request?.assertionConsumerServiceUrl ?? entities.acsUrl;
      const requestId = extract.request?.id ?? '';

      assertAcsAllowed(acsUrl, cfg.SLACK_TEAM_HOST);

      // Anonymous → stash the AuthnRequest in the resume cookie, redirect to /login.
      if (!request.session.personId) {
        const resumeToken = await signSamlResume(
          {
            samlRequest: samlRequestB64,
            relayState,
            acsUrl,
            requestId,
          },
          cfg.CFP_JWT_SIGNING_KEY,
        );
        reply.setCookie(RESUME_COOKIE, resumeToken, {
          httpOnly: true,
          sameSite: 'lax',
          secure: isSecure(cfg.NODE_ENV),
          path: '/api/saml',
          maxAge: RESUME_COOKIE_TTL_SECONDS,
        });
        const resumeReturn = `${originBase(request)}/api/saml/slack/sso/resume`;
        return reply.redirect(`/login?return=${encodeURIComponent(resumeReturn)}`);
      }

      // Signed in — build the assertion immediately.
      const { person, profile } = await loadPersonAndProfile(fastify, request.session.personId);
      const user = buildAssertionUser({ person, profile });

      const customTagReplacement = buildCustomTagReplacement({
        user,
        slackTeamHost: cfg.SLACK_TEAM_HOST,
        issuerEntityId: entities.entityId,
        inResponseTo: requestId,
        generateID: () => `_${cryptoRandomId()}`,
      });

      const bindingCtx = await entities.idp.createLoginResponse(
        entities.sp,
        { extract: parsed.extract },
        'post',
        {},
        { relayState, customTagReplacement },
      );

      const samlResponse = bindingCtx.context;
      const actionUrl =
        'entityEndpoint' in bindingCtx && typeof bindingCtx.entityEndpoint === 'string'
          ? bindingCtx.entityEndpoint
          : acsUrl;
      const replyRelayState =
        'relayState' in bindingCtx ? bindingCtx.relayState : relayState;

      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(
          renderPostForm({
            actionUrl,
            samlResponse,
            relayState: replyRelayState ?? undefined,
          }),
        );
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/saml/slack/sso/resume  — post-/login continuation of the
  // SP-initiated flow
  // -------------------------------------------------------------------------

  fastify.get(
    '/api/saml/slack/sso/resume',
    {
      schema: {
        tags: ['saml'],
        summary: 'Resume SP-initiated Slack sign-in after /login',
      },
    },
    async (request, reply) => {
      const cfg = fastify.config;
      if (!cfg.SAML_PRIVATE_KEY || !cfg.SAML_CERTIFICATE) {
        return reply.code(500).send(
          errorResponse(
            'saml_signing_failed',
            'SAML IdP is not configured',
            (request as FastifyRequest & { traceId?: string }).traceId,
          ),
        );
      }

      if (!request.session.personId) {
        return reply.redirect(`/login?return=${encodeURIComponent(safeReturnPath(request.url))}`);
      }

      const resumeCookie = request.cookies[RESUME_COOKIE];
      if (!resumeCookie) {
        throw new ApiValidationError('No SAML resume cookie present');
      }

      let resumeClaims;
      try {
        resumeClaims = await verifySamlResume(resumeCookie, cfg.CFP_JWT_SIGNING_KEY);
      } catch (err) {
        fastify.log.warn({ err }, 'SAML resume cookie verification failed');
        reply.clearCookie(RESUME_COOKIE, { path: '/api/saml' });
        throw new ApiValidationError('SAML resume cookie invalid or expired');
      }

      reply.clearCookie(RESUME_COOKIE, { path: '/api/saml' });

      assertAcsAllowed(resumeClaims.acsUrl, cfg.SLACK_TEAM_HOST);

      const { entities } = getSamlContext(fastify);
      const { person, profile } = await loadPersonAndProfile(fastify, request.session.personId);
      const user = buildAssertionUser({ person, profile });

      // Re-parse the stored AuthnRequest to rebuild requestInfo for InResponseTo.
      const parsed = await entities.idp.parseLoginRequest(entities.sp, 'post', {
        body: { SAMLRequest: resumeClaims.samlRequest },
      });

      const customTagReplacement = buildCustomTagReplacement({
        user,
        slackTeamHost: cfg.SLACK_TEAM_HOST,
        issuerEntityId: entities.entityId,
        inResponseTo: resumeClaims.requestId,
        generateID: () => `_${cryptoRandomId()}`,
      });

      const bindingCtx = await entities.idp.createLoginResponse(
        entities.sp,
        { extract: parsed.extract },
        'post',
        {},
        { relayState: resumeClaims.relayState, customTagReplacement },
      );

      const samlResponse = bindingCtx.context;
      const actionUrl =
        'entityEndpoint' in bindingCtx && typeof bindingCtx.entityEndpoint === 'string'
          ? bindingCtx.entityEndpoint
          : resumeClaims.acsUrl;
      const replyRelayState =
        'relayState' in bindingCtx ? bindingCtx.relayState : resumeClaims.relayState;

      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(
          renderPostForm({
            actionUrl,
            samlResponse,
            relayState: replyRelayState ?? undefined,
          }),
        );
    },
  );
}
