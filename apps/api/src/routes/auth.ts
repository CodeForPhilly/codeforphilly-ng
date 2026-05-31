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
import { createHash, randomBytes } from 'node:crypto';
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
import {
  dummyVerify,
  rehashPassword,
  verifyLegacyPassword,
} from '../auth/legacy-password.js';
import type { SessionMeta } from '../auth/session-metadata.js';
import type { LegacyPasswordCredential, PasswordToken } from '@cfp/shared/schemas';
import {
  generateCsrfState,
  generatePkceVerifier,
  pkceChallengeFromVerifier,
} from '../auth/oauth-pkce.js';
import {
  signOAuthSession,
  verifyOAuthSession,
} from '../auth/oauth-session-cookie.js';
import { buildAuthorizeUrl, completeCallback, completeLinkCallback } from '../auth/github-oauth.js';

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

function accountErrorRedirect(reply: FastifyReply, code: string): FastifyReply {
  return reply.redirect(`/account?error=${encodeURIComponent(code)}`);
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

      const isLinkMode = sessionClaims.mode === 'link';

      if (!query.code) {
        clearOAuthCookies(reply);
        return isLinkMode
          ? accountErrorRedirect(reply, 'github_unreachable')
          : loginErrorRedirect(reply, 'github_unreachable');
      }

      // Link mode: completely separate pipeline. No matching, no session
      // mint — just bind the GitHub identity to the named Person and
      // redirect back to /account.
      if (isLinkMode && sessionClaims.linkPersonId) {
        const linkOutcome = await completeLinkCallback({
          fastify,
          request,
          code: query.code,
          codeVerifier: sessionClaims.codeVerifier,
          redirectUri: callbackRedirectUri(request),
          linkPersonId: sessionClaims.linkPersonId,
        });
        clearOAuthCookies(reply);
        if (linkOutcome.kind === 'error') {
          return accountErrorRedirect(reply, linkOutcome.code);
        }
        return reply.redirect('/account?linked=github');
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
      const person = session.person ?? null;
      return ok({
        person,
        accountLevel: session.accountLevel,
        // `hasGitHubLink` is derived from Person.githubUserId. For anonymous
        // callers (no person), it's false. For password-only legacy users
        // it's false until they link via the /account banner.
        hasGitHubLink: person !== null && typeof person.githubUserId === 'number',
        // `lastLoginMethod` reflects how the *current* session was minted.
        // Undefined when the session predates the loginMethod claim or when
        // anonymous. Returned as null for the SPA to treat uniformly.
        lastLoginMethod: session.loginMethod ?? null,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/auth/link-github — initiate GitHub-link flow for current session
  // ---------------------------------------------------------------------------
  //
  // Per specs/api/auth.md `POST /api/auth/link-github`. Auth-required. Signs
  // a link-mode `cfp_oauth_session` cookie carrying the current personId,
  // then 302s to GitHub OAuth. The callback at `/api/auth/github/callback`
  // recognizes the mode and binds the GitHub identity to the signed-in
  // Person instead of minting a new session.
  // ---------------------------------------------------------------------------

  fastify.post(
    '/api/auth/link-github',
    {
      schema: {
        tags: ['auth'],
        summary: 'Link the current session to a GitHub identity',
        querystring: {
          type: 'object',
          properties: { return: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, ['user']);
      const cfg = fastify.config;
      if (!cfg.GITHUB_OAUTH_CLIENT_ID || !cfg.GITHUB_OAUTH_CLIENT_SECRET) {
        return accountErrorRedirect(reply, 'github_unreachable');
      }

      const personId = request.session.person?.id;
      if (!personId) {
        // requireAuth above already throws on no session; this is purely
        // a type-narrowing guard for the linePersonId argument below.
        throw new UnauthenticatedError('No session', 'no_session');
      }

      // Fast-fail before round-tripping to GitHub if already linked.
      const person = fastify.inMemoryState.people.get(personId);
      if (person && typeof person.githubUserId === 'number') {
        return accountErrorRedirect(reply, 'github_already_linked');
      }

      const { return: returnParam } = request.query as { return?: string };
      const returnPath = safeReturnPath(returnParam) === '/' ? '/account' : safeReturnPath(returnParam);

      const state = generateCsrfState();
      const codeVerifier = generatePkceVerifier();
      const codeChallenge = pkceChallengeFromVerifier(codeVerifier);

      const sessionToken = await signOAuthSession(
        {
          state,
          codeVerifier,
          return: returnPath,
          mode: 'link',
          linkPersonId: personId,
        },
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
  // POST /api/auth/login — legacy password sign-in
  //
  // Per specs/api/auth.md + specs/behaviors/account-migration.md +
  // specs/behaviors/password-hash-rotation.md. Accepts any Person with a
  // LegacyPasswordCredential on file. Verifies via the three-algorithm
  // dispatcher, rotates the credential to argon2id on success, mints a
  // session with loginMethod: 'legacy_password'.
  //
  // All failure paths return a uniform 401 with `error.code =
  // "invalid_credentials"` and run a dummy argon2 verify so wall-clock
  // timing across "no such user," "no credential," "wrong password,"
  // and "unknown format" is comparable.
  // ---------------------------------------------------------------------------

  fastify.post(
    '/api/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Sign in with legacy laddr credentials',
        body: {
          type: 'object',
          properties: {
            usernameOrEmail: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 1 },
          },
          required: ['usernameOrEmail', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { usernameOrEmail, password } = request.body as {
        usernameOrEmail: string;
        password: string;
      };

      // Resolve to a personId. Slug first (already normalized lowercase
      // in personIdBySlug); else by email through the private store's
      // email index. The latter respects the same lowercase convention.
      const trimmed = usernameOrEmail.trim();
      let personId = fastify.inMemoryState.personIdBySlug.get(trimmed.toLowerCase()) ?? null;
      if (!personId && trimmed.includes('@')) {
        personId = await fastify.store.private.findPersonIdByEmail(trimmed.toLowerCase());
      }

      if (!personId) {
        // Anti-enumeration: keep timing comparable to the verify path.
        await dummyVerify();
        throw new UnauthenticatedError('Invalid credentials', 'invalid_credentials');
      }

      const person = fastify.inMemoryState.people.get(personId);
      if (!person || person.deletedAt) {
        await dummyVerify();
        throw new UnauthenticatedError('Invalid credentials', 'invalid_credentials');
      }

      const cred = await fastify.store.private.getLegacyPassword(personId);
      if (!cred) {
        await dummyVerify();
        throw new UnauthenticatedError('Invalid credentials', 'invalid_credentials');
      }

      const verifyResult = await verifyLegacyPassword(password, cred.passwordHash);
      if (!verifyResult.valid) {
        throw new UnauthenticatedError('Invalid credentials', 'invalid_credentials');
      }

      // Update the credential — rehash to current argon2id params if
      // needed, always refresh lastUsedAt. The credential record stays
      // on file (vs. the by-password claim flow which deletes it).
      const newHash = verifyResult.needsRehash
        ? await rehashPassword(password)
        : cred.passwordHash;
      const updated: LegacyPasswordCredential = {
        ...cred,
        passwordHash: newHash,
        lastUsedAt: new Date().toISOString(),
      };
      await fastify.store.private.putLegacyPassword(updated);

      // Mint session. loginMethod = 'legacy_password' surfaces on
      // /api/auth/me so the SPA can render the "you signed in via
      // password — connect GitHub for faster sign-in next time" hint.
      const tokens = await issueSession(
        personId,
        person.accountLevel,
        fastify.config.CFP_JWT_SIGNING_KEY,
        { loginMethod: 'legacy_password' },
      );
      await persistSessionMetadata(fastify, request, tokens.refreshJti, personId);

      setSessionCookies(
        reply,
        { access: tokens.access, refresh: tokens.refresh },
        fastify.config.NODE_ENV,
      );

      return ok({ person });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/auth/password-reset/request — email a one-time reset link
  // ---------------------------------------------------------------------------
  //
  // Spec: specs/api/auth.md `POST /api/auth/password-reset/request`. Always
  // returns 202 regardless of whether the address resolved — anti-enumeration.
  // The notifier send is fire-and-forget so wall-clock timing across all
  // "did nothing" branches matches the "queued an email" branch.
  // ---------------------------------------------------------------------------

  fastify.post(
    '/api/auth/password-reset/request',
    {
      schema: {
        tags: ['auth'],
        summary: 'Request a password-reset link',
        body: {
          type: 'object',
          properties: {
            usernameOrEmail: { type: 'string', minLength: 1 },
          },
          required: ['usernameOrEmail'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { usernameOrEmail } = request.body as { usernameOrEmail: string };
      const trimmed = usernameOrEmail.trim();

      // Resolve to a personId. Same convention as /api/auth/login: slug
      // first, then email if it looks like one.
      let personId = fastify.inMemoryState.personIdBySlug.get(trimmed.toLowerCase()) ?? null;
      if (!personId && trimmed.includes('@')) {
        personId = await fastify.store.private.findPersonIdByEmail(trimmed.toLowerCase());
      }

      // Three silent no-ops, all converging to 202: unresolved person,
      // deleted person, or no LegacyPasswordCredential on file. The last
      // matters because specs/api/auth.md § Notes guarantees that
      // password-reset never *creates* a credential for a person who
      // doesn't already have one — GitHub-only signups can't reset into
      // a password account.
      const person = personId ? fastify.inMemoryState.people.get(personId) : null;
      const cred = personId ? await fastify.store.private.getLegacyPassword(personId) : null;
      const profile = personId ? await fastify.store.private.getProfile(personId) : null;

      if (personId && person && !person.deletedAt && cred && profile?.email) {
        const plaintext = randomBytes(32).toString('base64url');
        const tokenHash = createHash('sha256').update(plaintext).digest('hex');
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
        const tokenRecord: PasswordToken = {
          tokenHash,
          personId,
          issuedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          usedAt: null,
        };
        await fastify.store.private.putPasswordToken(tokenRecord);

        // Fire-and-forget — never block the response on Resend latency.
        void fastify.notifier
          .notifyPasswordReset({
            email: profile.email,
            fullName: person.fullName,
            slug: person.slug,
            token: plaintext,
            expiresAt: expiresAt.toISOString(),
          })
          .catch((err) => {
            fastify.log.error({ err, slug: person.slug }, 'password-reset notification threw');
          });
      }

      return reply.code(202).send(ok({ delivered: true }));
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/auth/password-reset/confirm — consume token + set new password
  // ---------------------------------------------------------------------------
  //
  // Spec: specs/api/auth.md `POST /api/auth/password-reset/confirm`. All
  // failure modes — unknown token, expired token, already-used token,
  // missing person, missing credential — collapse to a uniform 401
  // `invalid_token` so an attacker can't distinguish.
  //
  // Successful confirm mints a session with loginMethod 'password_reset'
  // so the SPA can recognize this path and surface the "link GitHub for
  // faster sign-in" prompt on the first /account view.
  // ---------------------------------------------------------------------------

  fastify.post(
    '/api/auth/password-reset/confirm',
    {
      schema: {
        tags: ['auth'],
        summary: 'Confirm a password reset',
        body: {
          type: 'object',
          properties: {
            token: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 8 },
          },
          required: ['token', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { token, password } = request.body as { token: string; password: string };

      const tokenHash = createHash('sha256').update(token).digest('hex');
      const record = await fastify.store.private.getPasswordToken(tokenHash);

      const now = new Date();
      if (!record || record.usedAt || new Date(record.expiresAt) <= now) {
        throw new UnauthenticatedError('Invalid or expired token', 'invalid_token');
      }

      const person = fastify.inMemoryState.people.get(record.personId);
      if (!person || person.deletedAt) {
        throw new UnauthenticatedError('Invalid or expired token', 'invalid_token');
      }

      const existing = await fastify.store.private.getLegacyPassword(record.personId);
      if (!existing) {
        // Per specs/api/auth.md § Notes: password-reset never *creates*
        // a credential for a person who doesn't already have one.
        throw new UnauthenticatedError('Invalid or expired token', 'invalid_token');
      }

      const newHash = await rehashPassword(password);
      const updated: LegacyPasswordCredential = {
        ...existing,
        passwordHash: newHash,
        lastUsedAt: now.toISOString(),
      };
      await fastify.store.private.putLegacyPassword(updated);

      const consumed: PasswordToken = { ...record, usedAt: now.toISOString() };
      await fastify.store.private.putPasswordToken(consumed);

      const tokens = await issueSession(
        record.personId,
        person.accountLevel,
        fastify.config.CFP_JWT_SIGNING_KEY,
        { loginMethod: 'password_reset' },
      );
      await persistSessionMetadata(fastify, request, tokens.refreshJti, record.personId);

      setSessionCookies(
        reply,
        { access: tokens.access, refresh: tokens.refresh },
        fastify.config.NODE_ENV,
      );

      return ok({ person });
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
        // Preserve the loginMethod across refresh so `/api/auth/me`
        // continues reporting the original sign-in path. Older refresh
        // tokens issued before this claim existed → loginMethod undefined,
        // which `issueSession` correctly omits from the new tokens.
        claims.loginMethod ? { loginMethod: claims.loginMethod } : undefined,
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
