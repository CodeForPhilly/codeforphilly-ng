/**
 * JWT primitives for session management.
 *
 * Three token types with distinct cookies, paths, and TTLs:
 *   - access  (cfp_session,  path /, 15m)  — { sub: personId, jti, accountLevel, scope: 'session' }
 *   - refresh (cfp_refresh,  path /api/auth/refresh, 30d) — { sub: personId, jti, scope: 'refresh' }
 *   - claim   (cfp_claim,    path /api/account-claim, 5m) — { sub: ghId, scope: 'claim', ... }
 *
 * HS256 with CFP_JWT_SIGNING_KEY. Clock skew tolerance ±60s.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { uuidv7 } from 'uuidv7';

export type AccountLevel = 'anonymous' | 'user' | 'staff' | 'administrator';

export interface AccessClaims {
  readonly sub: string; // personId
  readonly jti: string;
  readonly accountLevel: AccountLevel;
  readonly exp: number;
  readonly iat: number;
}

export interface RefreshClaims {
  readonly sub: string; // personId
  readonly jti: string;
  readonly exp: number;
  readonly iat: number;
}

export interface GhIdentitySnapshot {
  readonly ghId: string;
  readonly ghLogin: string;
  readonly ghName: string | null;
  readonly ghEmails: string[];
}

export interface ClaimPendingClaims {
  readonly sub: string; // ghId
  readonly jti: string;
  readonly scope: 'claim';
  readonly ghLogin: string;
  readonly ghName: string | null;
  readonly ghEmails: string[];
  readonly candidates: string[]; // personId candidates
  readonly exp: number;
  readonly iat: number;
}

const CLOCK_SKEW_SECONDS = 60;
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLAIM_TTL_SECONDS = 5 * 60;

function keyBytes(signingKey: string): Uint8Array {
  return new TextEncoder().encode(signingKey);
}

export async function issueSession(
  personId: string,
  accountLevel: AccountLevel,
  signingKey: string,
): Promise<{ access: string; refresh: string; accessJti: string; refreshJti: string }> {
  const accessJti = uuidv7();
  const refreshJti = uuidv7();
  const now = Math.floor(Date.now() / 1000);
  const key = keyBytes(signingKey);

  const access = await new SignJWT({
    sub: personId,
    jti: accessJti,
    accountLevel,
    scope: 'session',
  } satisfies Partial<JWTPayload> & { accountLevel: AccountLevel; scope: string })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TTL_SECONDS)
    .sign(key);

  const refresh = await new SignJWT({
    sub: personId,
    jti: refreshJti,
    scope: 'refresh',
  } satisfies Partial<JWTPayload> & { scope: string })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + REFRESH_TTL_SECONDS)
    .sign(key);

  return { access, refresh, accessJti, refreshJti };
}

export async function verifyAccess(token: string, signingKey: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, keyBytes(signingKey), {
    algorithms: ['HS256'],
    clockTolerance: CLOCK_SKEW_SECONDS,
  });

  if (payload['scope'] !== 'session') {
    throw new Error('Token scope mismatch: expected session');
  }

  return {
    sub: payload.sub!,
    jti: payload.jti!,
    accountLevel: payload['accountLevel'] as AccountLevel,
    exp: payload.exp!,
    iat: payload.iat!,
  };
}

export async function verifyRefresh(token: string, signingKey: string): Promise<RefreshClaims> {
  const { payload } = await jwtVerify(token, keyBytes(signingKey), {
    algorithms: ['HS256'],
    clockTolerance: CLOCK_SKEW_SECONDS,
  });

  if (payload['scope'] !== 'refresh') {
    throw new Error('Token scope mismatch: expected refresh');
  }

  return {
    sub: payload.sub!,
    jti: payload.jti!,
    exp: payload.exp!,
    iat: payload.iat!,
  };
}

export async function issueClaimPending(
  ghIdentity: GhIdentitySnapshot,
  candidates: string[],
  signingKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sub: ghIdentity.ghId,
    jti: uuidv7(),
    scope: 'claim',
    ghLogin: ghIdentity.ghLogin,
    ghName: ghIdentity.ghName,
    ghEmails: ghIdentity.ghEmails,
    candidates,
  } satisfies Partial<JWTPayload> & {
    scope: string;
    ghLogin: string;
    ghName: string | null;
    ghEmails: string[];
    candidates: string[];
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + CLAIM_TTL_SECONDS)
    .sign(keyBytes(signingKey));
}

export async function verifyClaimPending(token: string, signingKey: string): Promise<ClaimPendingClaims> {
  const { payload } = await jwtVerify(token, keyBytes(signingKey), {
    algorithms: ['HS256'],
    clockTolerance: CLOCK_SKEW_SECONDS,
  });

  if (payload['scope'] !== 'claim') {
    throw new Error('Token scope mismatch: expected claim');
  }

  return {
    sub: payload.sub!,
    jti: payload.jti!,
    scope: 'claim',
    ghLogin: payload['ghLogin'] as string,
    ghName: payload['ghName'] as string | null,
    ghEmails: payload['ghEmails'] as string[],
    candidates: payload['candidates'] as string[],
    exp: payload.exp!,
    iat: payload.iat!,
  };
}
