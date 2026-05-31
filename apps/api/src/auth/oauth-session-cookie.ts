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

/**
 * The OAuth round-trip can be either a fresh sign-in (`login`, the default)
 * or a link-existing-account-to-GitHub flow (`link`). `linkPersonId` is set
 * iff `mode === 'link'` and identifies the signed-in Person who initiated
 * the linking; the callback uses it to mutate the right Person record.
 *
 * Pre-link-flow cookies don't carry these fields; verify defaults `mode`
 * to `'login'` so the existing flow stays back-compat.
 */
export interface OAuthSessionClaims {
  readonly state: string;
  readonly codeVerifier: string;
  readonly return: string;
  readonly mode?: 'login' | 'link';
  readonly linkPersonId?: string;
}

function keyBytes(signingKey: string): Uint8Array {
  return new TextEncoder().encode(signingKey);
}

export async function signOAuthSession(
  claims: OAuthSessionClaims,
  signingKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Partial<JWTPayload> & {
    state: string;
    codeVerifier: string;
    return: string;
    scope: string;
    mode?: 'login' | 'link';
    linkPersonId?: string;
  } = {
    state: claims.state,
    codeVerifier: claims.codeVerifier,
    return: claims.return,
    scope: 'oauth_session',
    jti: uuidv7(),
  };
  if (claims.mode) payload.mode = claims.mode;
  if (claims.linkPersonId) payload.linkPersonId = claims.linkPersonId;

  return new SignJWT(payload)
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

  // Default mode = 'login' for back-compat with cookies issued before
  // the link-flow shipped. linkPersonId is only present in link mode.
  const rawMode = payload['mode'];
  const mode: 'login' | 'link' = rawMode === 'link' ? 'link' : 'login';
  const rawLinkPersonId = payload['linkPersonId'];
  const linkPersonId = typeof rawLinkPersonId === 'string' ? rawLinkPersonId : undefined;

  if (mode === 'link' && !linkPersonId) {
    throw new Error('Invalid oauth session claims: link mode requires linkPersonId');
  }

  const out: OAuthSessionClaims = { state, codeVerifier, return: returnUrl, mode };
  if (linkPersonId) {
    return { ...out, linkPersonId };
  }
  return out;
}
