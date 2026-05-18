/**
 * Auth routes — session management endpoints.
 *
 * Implements specs/api/auth.md:
 *   GET  /api/auth/github/start
 *   GET  /api/auth/github/callback
 *   GET  /api/auth/me
 *   POST /api/auth/refresh
 *   POST /api/auth/logout
 *   GET  /api/auth/sessions
 *   POST /api/auth/sessions/:jti/revoke
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errors as JoseErrors } from 'jose';
import { ok } from '../lib/response.js';
import { UnauthenticatedError, ConflictError, ApiNotFoundError } from '../lib/errors.js';
import { verifyRefresh, issueSession } from '../auth/jwt.js';
import {
  setSessionCookies,
  clearSessionCookies,
  setClaimCookie,
  setOAuthStateCookie,
  setOAuthSessionCookie,
  clearOAuthCookies,
} from '../auth/cookies.js';
import { requireAuth } from '../auth/guards.js';
import type { SessionMeta } from '../auth/session-metadata.js';
import {
  generateCsrfState,
  generatePkceVerifier,
  pkceChallengeFromVerifier,
} from '../auth/oauth-pkce.js';
import {
  signOAuthSession,
  verifyOAuthSession,
} from '../auth/oauth-session-cookie.js';
import { buildAuthorizeUrl, completeCallback } from '../auth/github-oauth.js';

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return (forwarded.split(',')[0] ?? '').trim();
  }
  return request.socket?.remoteAddress ?? 'unknown';
}

function safeReturnPath(input: string | undefined | null): string {
  if (!input || typeof input !== 'string') return '/';
  // Must be a same-origin path: starts with '/' but not '//' (protocol-relative).
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

function callbackRedirectUri(request: FastifyRequest): string {
  // GitHub OAuth Apps require the redirect_uri sent at /authorize to exactly
  // match what was registered. We derive it from the inbound request so dev,
  // staging, and prod each end up routing back to themselves without an env var.
  const protocol = request.headers['x-forwarded-proto']
    ? String(request.headers['x-forwarded-proto']).split(',')[0]?.trim() ?? 'http'
    : request.protocol;
  const host = request.headers['x-forwarded-host']
    ? String(request.headers['x-forwarded-host']).split(',')[0]?.trim() ?? request.hostname
    : request.hostname;
  return `${protocol}://${host}/api/auth/github/callback`;
}

function loginErrorRedirect(reply: FastifyReply, code: string): FastifyReply {
  return reply.redirect(`/login?error=${encodeURIComponent(code)}`);
}

async function persistSessionMetadata(
  fastify: FastifyInstance,
  request: FastifyRequest,
  refreshJti: string,
  personId: string,
): Promise<void> {
  const now = Date.now();
  const meta: SessionMeta = {
    refreshJti,
    personId,
    userAgent: String(request.headers['user-agent'] ?? ''),
    ipAddress: clientIp(request),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
  await fastify.sessionMetadata.add(meta, fastify.store.private);
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {

  // ---------------------------------------------------------------------------
  // GET /api/auth/github/start
  // ---------------------------------------------------------------------------

  fastify.get(
    '/api/auth/github/start',
    {
      schema: {
        tags: ['auth'],
        summary: 'Begin GitHub OAuth flow',
        querystring: {
          type: 'object',
          properties: { return: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const cfg = fastify.config;
      if (!cfg.GITHUB_OAUTH_CLIENT_ID || !cfg.GITHUB_OAUTH_CLIENT_SECRET) {
        return loginErrorRedirect(reply, 'github_unreachable');
      }

      const { return: returnParam } = request.query as { return?: string };
      const returnPath = safeReturnPath(returnParam);

      const state = generateCsrfState();
      const codeVerifier = generatePkceVerifier();
      const codeChallenge = pkceChallengeFromVerifier(codeVerifier);

      const sessionToken = await signOAuthSession(
        { state, codeVerifier, return: returnPath },
        cfg.CFP_JWT_SIGNING_KEY,
      );

      setOAuthStateCookie(reply, state, cfg.NODE_ENV);
      setOAuthSessionCookie(reply, sessionToken, cfg.NODE_ENV);

      const url = buildAuthorizeUrl({
        clientId: cfg.GITHUB_OAUTH_CLIENT_ID,
        redirectUri: callbackRedirectUri(request),
        state,
        codeChallenge,
      });

      return reply.redirect(url);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/auth/github/callback
  // ---------------------------------------------------------------------------

  fastify.get(
    '/api/auth/github/callback',
    {
      schema: {
        tags: ['auth'],
        summary: 'GitHub OAuth callback',
        querystring: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            state: { type: 'string' },
            error: { type: 'string' },
            error_description: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const cfg = fastify.config;
      const query = request.query as {
        code?: string;
        state?: string;
        error?: string;
        error_description?: string;
      };

      // User denied (or some other GitHub-originated error) — surface to /login.
      if (query.error) {
        clearOAuthCookies(reply);
        return loginErrorRedirect(reply, query.error);
      }

      // Validate state cookie vs query state (CSRF).
      const stateCookie = request.cookies['cfp_oauth_state'];
      const oauthSessionCookie = request.cookies['cfp_oauth_session'];

      if (!query.state || !stateCookie || query.state !== stateCookie) {
        clearOAuthCookies(reply);
        return loginErrorRedirect(reply, 'oauth_state_mismatch');
      }

      if (!oauthSessionCookie) {
        clearOAuthCookies(reply);
        return loginErrorRedirect(reply, 'oauth_session_invalid');
      }

      let sessionClaims;
      try {
        sessionClaims = await verifyOAuthSession(oauthSessionCookie, cfg.CFP_JWT_SIGNING_KEY);
      } catch (err) {
        fastify.log.warn({ err }, 'oauth session cookie verification failed');
        clearOAuthCookies(reply);
        return loginErrorRedirect(reply, 'oauth_session_invalid');
      }

      if (sessionClaims.state !== query.state) {
        clearOAuthCookies(reply);
        return loginErrorRedirect(reply, 'oauth_state_mismatch');
      }

      if (!query.code) {
        clearOAuthCookies(reply);
        return loginErrorRedirect(reply, 'github_unreachable');
      }

      // Pipeline: code → token → user/emails → match → outcome.
      const outcome = await completeCallback({
        fastify,
        request,
        code: query.code,
        codeVerifier: sessionClaims.codeVerifier,
        redirectUri: callbackRedirectUri(request),
      });

      clearOAuthCookies(reply);

      if (outcome.kind === 'error') {
        return loginErrorRedirect(reply, outcome.code);
      }

      if (outcome.kind === 'claim-pending') {
        setClaimCookie(reply, outcome.token, cfg.NODE_ENV);
        const target = `/account-claim?return=${encodeURIComponent(sessionClaims.return)}`;
        return reply.redirect(target);
      }

      // session — set cookies, persist metadata, redirect to safe return.
      setSessionCookies(
        reply,
        { access: outcome.accessToken, refresh: outcome.refreshToken },
        cfg.NODE_ENV,
      );
      await persistSessionMetadata(fastify, request, outcome.refreshJti, outcome.personId);
      return reply.redirect(sessionClaims.return);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/auth/me — returns current person or anonymous
  // ---------------------------------------------------------------------------

  fastify.get(
    '/api/auth/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Return current session info',
      },
    },
    async (request) => {
      const { session } = request;
      return ok({
        person: session.person ?? null,
        accountLevel: session.accountLevel,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/auth/refresh — mint new access+refresh pair from refresh cookie
  // ---------------------------------------------------------------------------

  fastify.post(
    '/api/auth/refresh',
    { schema: { tags: ['auth'], summary: 'Refresh session tokens' } },
    async (request, reply) => {
      const refreshToken = request.cookies['cfp_refresh'];
      if (!refreshToken) {
        throw new UnauthenticatedError('No refresh token', 'no_refresh_token');
      }

      let claims;
      try {
        claims = await verifyRefresh(refreshToken, fastify.config.CFP_JWT_SIGNING_KEY);
      } catch (err) {
        if (err instanceof JoseErrors.JWTExpired) {
          throw new UnauthenticatedError('Refresh token expired', 'refresh_token_expired');
        }
        throw new UnauthenticatedError('Refresh token invalid', 'refresh_token_invalid');
      }

      if (
        fastify.revocations.isRevoked(claims.jti) ||
        fastify.revocations.isCoveredBySentinel(claims.sub, claims.iat)
      ) {
        throw new UnauthenticatedError('Refresh token revoked', 'refresh_token_revoked');
      }

      const person = fastify.inMemoryState.people.get(claims.sub);
      if (!person) {
        throw new UnauthenticatedError('Person not found', 'refresh_token_revoked');
      }

      const newTokens = await issueSession(
        claims.sub,
        person.accountLevel,
        fastify.config.CFP_JWT_SIGNING_KEY,
      );

      const oldExpiresAt = new Date(claims.exp * 1000).toISOString();
      await fastify.revocations.revoke(
        { jti: claims.jti, personId: claims.sub, expiresAt: oldExpiresAt },
        fastify.store.public,
      );
      await fastify.sessionMetadata.remove(claims.jti, fastify.store.private);

      const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const newMeta: SessionMeta = {
        refreshJti: newTokens.refreshJti,
        personId: claims.sub,
        userAgent: String(request.headers['user-agent'] ?? ''),
        ipAddress: clientIp(request),
        issuedAt: new Date().toISOString(),
        expiresAt: newExpiresAt,
      };
      await fastify.sessionMetadata.add(newMeta, fastify.store.private);

      setSessionCookies(reply, { access: newTokens.access, refresh: newTokens.refresh }, fastify.config.NODE_ENV);
      return reply.code(200).send(ok(null));
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/auth/logout — revoke current session
  // ---------------------------------------------------------------------------

  fastify.post(
    '/api/auth/logout',
    { schema: { tags: ['auth'], summary: 'End current session' } },
    async (request, reply) => {
      const { session } = request;
      const personId = session.personId ?? session.person?.id;

      if (session.jti && personId) {
        const accessExp = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await fastify.revocations.revoke(
          { jti: session.jti, personId, expiresAt: accessExp },
          fastify.store.public,
        );
      }

      const refreshToken = request.cookies['cfp_refresh'];
      if (refreshToken) {
        try {
          const refreshClaims = await verifyRefresh(refreshToken, fastify.config.CFP_JWT_SIGNING_KEY);
          const refreshExp = new Date(refreshClaims.exp * 1000).toISOString();
          await fastify.revocations.revoke(
            { jti: refreshClaims.jti, personId: refreshClaims.sub, expiresAt: refreshExp },
            fastify.store.public,
          );
          await fastify.sessionMetadata.remove(refreshClaims.jti, fastify.store.private);
        } catch {
          // If the refresh token is already invalid, just proceed
        }
      }

      clearSessionCookies(reply);
      return reply.code(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/auth/sessions — list remembered sessions with metadata
  // ---------------------------------------------------------------------------

  fastify.get(
    '/api/auth/sessions',
    { schema: { tags: ['auth'], summary: 'List active sessions' } },
    async (request) => {
      requireAuth(request, ['user']);
      const { session } = request;
      const personId = session.personId ?? session.person!.id;

      let currentRefreshJti: string | null = null;
      const refreshToken = request.cookies['cfp_refresh'];
      if (refreshToken) {
        try {
          const claims = await verifyRefresh(refreshToken, fastify.config.CFP_JWT_SIGNING_KEY);
          currentRefreshJti = claims.jti;
        } catch {
          // Expired or invalid refresh cookie — no current jti
        }
      }

      const allMeta = fastify.sessionMetadata.getAll(personId);
      const sessions = allMeta
        .filter((meta) => !fastify.revocations.isRevoked(meta.refreshJti))
        .map((meta) => ({
          jti: meta.refreshJti,
          userAgent: meta.userAgent,
          ipAddress: meta.ipAddress,
          issuedAt: meta.issuedAt,
          expiresAt: meta.expiresAt,
          current: meta.refreshJti === currentRefreshJti,
        }));

      return ok(sessions);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/auth/sessions/:jti/revoke — revoke a non-current session
  // ---------------------------------------------------------------------------

  fastify.post(
    '/api/auth/sessions/:jti/revoke',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke a specific session',
        params: { type: 'object', properties: { jti: { type: 'string' } }, required: ['jti'] },
      },
    },
    async (request, reply) => {
      requireAuth(request, ['user']);
      const { session } = request;
      const personId = session.personId ?? session.person!.id;
      const { jti } = request.params as { jti: string };

      const refreshToken = request.cookies['cfp_refresh'];
      if (refreshToken) {
        try {
          const refreshClaims = await verifyRefresh(refreshToken, fastify.config.CFP_JWT_SIGNING_KEY);
          if (refreshClaims.jti === jti) {
            throw new ConflictError('Cannot revoke the current session', 'cannot_revoke_current_session');
          }
        } catch (err) {
          if (err instanceof ConflictError) throw err;
          // Ignore parse errors — current session check fails gracefully
        }
      }

      const meta = fastify.sessionMetadata.get(jti);
      if (!meta || meta.personId !== personId) {
        throw new ApiNotFoundError('Session not found');
      }

      await fastify.revocations.revoke(
        { jti, personId, expiresAt: meta.expiresAt },
        fastify.store.public,
      );
      await fastify.sessionMetadata.remove(jti, fastify.store.private);

      return reply.code(204).send();
    },
  );
}
