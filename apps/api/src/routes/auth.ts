/**
 * Auth routes — session management endpoints.
 *
 * Implements specs/api/auth.md:
 *   GET  /api/auth/me
 *   POST /api/auth/refresh
 *   POST /api/auth/logout
 *   GET  /api/auth/sessions
 *   POST /api/auth/sessions/:jti/revoke
 *
 * OAuth flow stubs (return 501 until github-oauth plan):
 *   GET  /api/auth/github/start
 *   GET  /api/auth/github/callback
 */
import type { FastifyInstance } from 'fastify';
import { errors as JoseErrors } from 'jose';
import { ok } from '../lib/response.js';
import { UnauthenticatedError, ConflictError, ApiNotFoundError } from '../lib/errors.js';
import { verifyRefresh, issueSession } from '../auth/jwt.js';
import { setSessionCookies, clearSessionCookies } from '../auth/cookies.js';
import { requireAuth } from '../auth/guards.js';
import type { SessionMeta } from '../auth/session-metadata.js';

function clientIp(request: import('fastify').FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return (forwarded.split(',')[0] ?? '').trim();
  }
  return request.socket?.remoteAddress ?? 'unknown';
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {

  // ---------------------------------------------------------------------------
  // OAuth stubs — return 501 until github-oauth plan is implemented
  // ---------------------------------------------------------------------------

  fastify.get(
    '/api/auth/github/start',
    { schema: { tags: ['auth'], summary: 'Begin GitHub OAuth flow (not yet wired)' } },
    async (_request, reply) => {
      return reply.code(501).send({
        success: false,
        error: { code: 'oauth_not_yet_wired', message: 'GitHub OAuth flow is not yet implemented' },
        metadata: { timestamp: new Date().toISOString() },
      });
    },
  );

  fastify.get(
    '/api/auth/github/callback',
    { schema: { tags: ['auth'], summary: 'GitHub OAuth callback (not yet wired)' } },
    async (_request, reply) => {
      return reply.code(501).send({
        success: false,
        error: { code: 'oauth_not_yet_wired', message: 'GitHub OAuth flow is not yet implemented' },
        metadata: { timestamp: new Date().toISOString() },
      });
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

      // Look up person to get current accountLevel
      const person = await fastify.store.public.people.queryFirst({ id: claims.sub });
      if (!person) {
        throw new UnauthenticatedError('Person not found', 'refresh_token_revoked');
      }

      const newTokens = await issueSession(
        claims.sub,
        person.accountLevel,
        fastify.config.CFP_JWT_SIGNING_KEY,
      );

      // Revoke the old refresh jti
      const oldExpiresAt = new Date(claims.exp * 1000).toISOString();
      await fastify.revocations.revoke(
        { jti: claims.jti, personId: claims.sub, expiresAt: oldExpiresAt },
        fastify.store.public,
      );
      await fastify.sessionMetadata.remove(claims.jti, fastify.store.private);

      // Store metadata for new refresh token
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

      // Revoke access jti — use personId from claims (available even without person lookup)
      if (session.jti && personId) {
        const accessExp = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await fastify.revocations.revoke(
          { jti: session.jti, personId, expiresAt: accessExp },
          fastify.store.public,
        );
      }

      // Revoke the refresh token as well
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

      // Get current refresh jti from cookie
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

      // Identify current refresh jti
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
