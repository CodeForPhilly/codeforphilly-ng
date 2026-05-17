/**
 * Cookie helpers for session JWT management.
 *
 * Consistent set/clear for cfp_session, cfp_refresh, cfp_claim across all
 * auth endpoints. The Secure flag is omitted in non-production environments
 * per specs/behaviors/authorization.md.
 */
import type { FastifyReply } from 'fastify';

const COOKIE_OPTS_BASE = {
  httpOnly: true,
  sameSite: 'lax' as const,
};

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 5 * 60 * 1000;
const OAUTH_TTL_MS = 10 * 60 * 1000;

function isSecure(nodeEnv: string): boolean {
  return nodeEnv === 'production';
}

export function setSessionCookies(
  reply: FastifyReply,
  tokens: { access: string; refresh: string },
  nodeEnv: string,
): void {
  const secure = isSecure(nodeEnv);

  reply.setCookie('cfp_session', tokens.access, {
    ...COOKIE_OPTS_BASE,
    secure,
    path: '/',
    maxAge: ACCESS_TTL_MS / 1000,
  });

  reply.setCookie('cfp_refresh', tokens.refresh, {
    ...COOKIE_OPTS_BASE,
    secure,
    path: '/api/auth/refresh',
    maxAge: REFRESH_TTL_MS / 1000,
  });
}

export function setClaimCookie(reply: FastifyReply, token: string, nodeEnv: string): void {
  reply.setCookie('cfp_claim', token, {
    ...COOKIE_OPTS_BASE,
    secure: isSecure(nodeEnv),
    path: '/api/account-claim',
    maxAge: CLAIM_TTL_MS / 1000,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie('cfp_session', { path: '/' });
  reply.clearCookie('cfp_refresh', { path: '/api/auth/refresh' });
}

export function clearClaimCookie(reply: FastifyReply): void {
  reply.clearCookie('cfp_claim', { path: '/api/account-claim' });
}

export function setOAuthStateCookie(reply: FastifyReply, state: string, nodeEnv: string): void {
  reply.setCookie('cfp_oauth_state', state, {
    ...COOKIE_OPTS_BASE,
    secure: isSecure(nodeEnv),
    path: '/api/auth',
    maxAge: OAUTH_TTL_MS / 1000,
  });
}

export function setOAuthSessionCookie(
  reply: FastifyReply,
  token: string,
  nodeEnv: string,
): void {
  reply.setCookie('cfp_oauth_session', token, {
    ...COOKIE_OPTS_BASE,
    secure: isSecure(nodeEnv),
    path: '/api/auth',
    maxAge: OAUTH_TTL_MS / 1000,
  });
}

export function clearOAuthCookies(reply: FastifyReply): void {
  reply.clearCookie('cfp_oauth_state', { path: '/api/auth' });
  reply.clearCookie('cfp_oauth_session', { path: '/api/auth' });
}
