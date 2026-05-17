/**
 * Sign + verify the short-lived `cfp_saml_resume` cookie that carries the
 * inbound Slack AuthnRequest across a sign-in round-trip.
 *
 * When Slack POSTs an AuthnRequest to /api/saml/slack/sso while the caller is
 * anonymous, we stash the request payload in this signed cookie, redirect to
 * /login, and replay the SAML assertion build after the user signs in via the
 * resume endpoint.
 *
 * 10-minute TTL — matches the cfp_oauth_session cookie since the resume flow
 * must survive one OAuth round-trip.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { uuidv7 } from 'uuidv7';

const RESUME_TTL_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 60;

export interface SamlResumeClaims {
  /** Original base64-encoded SAMLRequest from Slack. */
  readonly samlRequest: string;
  /** RelayState pass-through. */
  readonly relayState: string;
  /** AssertionConsumerServiceURL extracted from the parsed AuthnRequest. */
  readonly acsUrl: string;
  /** AuthnRequest ID for setting InResponseTo on the eventual response. */
  readonly requestId: string;
}

function keyBytes(signingKey: string): Uint8Array {
  return new TextEncoder().encode(signingKey);
}

export async function signSamlResume(
  claims: SamlResumeClaims,
  signingKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    samlRequest: claims.samlRequest,
    relayState: claims.relayState,
    acsUrl: claims.acsUrl,
    requestId: claims.requestId,
    scope: 'saml_resume',
    jti: uuidv7(),
  } satisfies Partial<JWTPayload> & {
    samlRequest: string;
    relayState: string;
    acsUrl: string;
    requestId: string;
    scope: string;
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + RESUME_TTL_SECONDS)
    .sign(keyBytes(signingKey));
}

export async function verifySamlResume(
  token: string,
  signingKey: string,
): Promise<SamlResumeClaims> {
  const { payload } = await jwtVerify(token, keyBytes(signingKey), {
    algorithms: ['HS256'],
    clockTolerance: CLOCK_SKEW_SECONDS,
  });

  if (payload['scope'] !== 'saml_resume') {
    throw new Error('Token scope mismatch: expected saml_resume');
  }

  const samlRequest = payload['samlRequest'];
  const relayState = payload['relayState'];
  const acsUrl = payload['acsUrl'];
  const requestId = payload['requestId'];

  if (
    typeof samlRequest !== 'string' ||
    typeof relayState !== 'string' ||
    typeof acsUrl !== 'string' ||
    typeof requestId !== 'string'
  ) {
    throw new Error('Invalid saml resume claims');
  }

  return { samlRequest, relayState, acsUrl, requestId };
}
