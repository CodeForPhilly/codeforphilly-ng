/**
 * Sign + verify the short-lived `cfp_oauth_session` cookie that carries the
 * PKCE verifier and return URL across the OAuth round-trip.
 *
 * Signed (not encrypted) with the JWT signing key — none of these fields are
 * confidential on their own (the state cookie is the CSRF token, and the
 * verifier never leaves this server's possession in a usable way without the
 * code from GitHub).
 *
 * 10-minute TTL per specs/api/auth.md.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { uuidv7 } from 'uuidv7';

const OAUTH_SESSION_TTL_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 60;

export interface OAuthSessionClaims {
  readonly state: string;
  readonly codeVerifier: string;
  readonly return: string;
}

function keyBytes(signingKey: string): Uint8Array {
  return new TextEncoder().encode(signingKey);
}

export async function signOAuthSession(
  claims: OAuthSessionClaims,
  signingKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    state: claims.state,
    codeVerifier: claims.codeVerifier,
    return: claims.return,
    scope: 'oauth_session',
    jti: uuidv7(),
  } satisfies Partial<JWTPayload> & {
    state: string;
    codeVerifier: string;
    return: string;
    scope: string;
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + OAUTH_SESSION_TTL_SECONDS)
    .sign(keyBytes(signingKey));
}

export async function verifyOAuthSession(
  token: string,
  signingKey: string,
): Promise<OAuthSessionClaims> {
  const { payload } = await jwtVerify(token, keyBytes(signingKey), {
    algorithms: ['HS256'],
    clockTolerance: CLOCK_SKEW_SECONDS,
  });

  if (payload['scope'] !== 'oauth_session') {
    throw new Error('Token scope mismatch: expected oauth_session');
  }

  const state = payload['state'];
  const codeVerifier = payload['codeVerifier'];
  const returnUrl = payload['return'];

  if (typeof state !== 'string' || typeof codeVerifier !== 'string' || typeof returnUrl !== 'string') {
    throw new Error('Invalid oauth session claims');
  }

  return { state, codeVerifier, return: returnUrl };
}
