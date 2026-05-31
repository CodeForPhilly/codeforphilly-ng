/**
 * Session middleware — Fastify plugin.
 *
 * Decorates every request with `request.session: SessionContext`.
 * Also decorates the Fastify instance with `fastify.revocations` and
 * `fastify.sessionMetadata` for use by route handlers.
 *
 * Ordering: registered after store plugin (needs fastify.store + fastify.config).
 *
 * The cfp_claim cookie is intentionally not honored here — it's only valid
 * on /api/account-claim/* routes and is never treated as a session.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { errors as JoseErrors } from 'jose';

import type { AccountLevel, GhIdentitySnapshot, LoginMethod } from './jwt.js';
import { verifyAccess } from './jwt.js';
import { InMemoryRevocationStore } from './revocation.js';
import { SessionMetadataStore } from './session-metadata.js';
import type { Person } from '@cfp/shared/schemas';

export interface SessionContext {
  /** Full Person record, or null for anonymous/claim-pending sessions. */
  readonly person: Person | null;
  readonly accountLevel: AccountLevel;
  /** personId from the JWT claims — set even when person lookup hasn't run. */
  readonly personId?: string;
  readonly jti?: string;
  readonly isClaimPending?: boolean;
  readonly ghIdentity?: GhIdentitySnapshot;
  /**
   * How this session was originally minted. Undefined for sessions that
   * predate the loginMethod claim (i.e., issued before phase B); the
   * frontend treats undefined as "unknown" and falls back to default UI.
   */
  readonly loginMethod?: LoginMethod;
}

const ANONYMOUS_SESSION: SessionContext = {
  person: null,
  accountLevel: 'anonymous',
};

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionContext;
  }
  interface FastifyInstance {
    revocations: InMemoryRevocationStore;
    sessionMetadata: SessionMetadataStore;
  }
}

async function sessionMiddlewarePlugin(fastify: FastifyInstance): Promise<void> {
  const revocations = new InMemoryRevocationStore();
  const sessionMetadata = new SessionMetadataStore();

  fastify.decorate('revocations', revocations);
  fastify.decorate('sessionMetadata', sessionMetadata);

  // Load revocation state from gitsheets + session metadata from private store at boot
  fastify.addHook('onReady', async () => {
    const allRevocations: import('@cfp/shared/schemas').Revocation[] = [];
    const revocationsSheet = fastify.store.public.revocations;
    for await (const record of revocationsSheet.query()) {
      allRevocations.push(record);
    }
    revocations.load(allRevocations);

    await sessionMetadata.load(fastify.store.private);
  });

  // Start the revocation sweeper — runs every 5 minutes
  let sweepInterval: ReturnType<typeof setInterval> | undefined;
  fastify.addHook('onReady', () => {
    sweepInterval = setInterval(
      () => {
        void revocations.sweep(fastify.store.public).catch((err) => {
          fastify.log.error({ err }, 'revocation sweeper failed');
        });
      },
      5 * 60 * 1000,
    );
  });

  fastify.addHook('onClose', () => {
    if (sweepInterval) clearInterval(sweepInterval);
  });

  // Decorate the request prototype with a default session
  fastify.decorateRequest('session', null as unknown as SessionContext);

  fastify.addHook('onRequest', async (request) => {
    const token = request.cookies['cfp_session'];
    if (!token) {
      request.session = ANONYMOUS_SESSION;
      return;
    }

    try {
      const claims = await verifyAccess(token, fastify.config.CFP_JWT_SIGNING_KEY);

      // Check revocation
      if (
        revocations.isRevoked(claims.jti) ||
        revocations.isCoveredBySentinel(claims.sub, claims.iat)
      ) {
        request.session = ANONYMOUS_SESSION;
        return;
      }

      // Look up person from the in-memory state map (keyed by id). Other
      // routes use the same path (`fastify.inMemoryState.people.get(personId)`)
      // for id→Person resolution; this is the canonical fast index. The
      // sheet-level `queryFirst({ id })` previously used here doesn't reflect
      // in-process writes between commit and the next refresh.
      const person = fastify.inMemoryState.people.get(claims.sub) ?? null;

      request.session = {
        person,
        accountLevel: claims.accountLevel,
        personId: claims.sub,
        jti: claims.jti,
        ...(claims.loginMethod !== undefined ? { loginMethod: claims.loginMethod } : {}),
      };
    } catch (err) {
      if (
        err instanceof JoseErrors.JWTExpired ||
        err instanceof JoseErrors.JWTInvalid ||
        err instanceof JoseErrors.JWSInvalid ||
        err instanceof JoseErrors.JWSSignatureVerificationFailed
      ) {
        // Expired or invalid token → anonymous, not an error
        request.session = ANONYMOUS_SESSION;
        return;
      }
      throw err;
    }
  });
}

export default fp(sessionMiddlewarePlugin, {
  name: 'session-middleware',
  fastify: '5.x',
  dependencies: ['store'],
});
