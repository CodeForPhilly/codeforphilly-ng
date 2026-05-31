/**
 * Account-claim routes per specs/api/account-claim.md.
 *
 * Endpoints:
 *   GET    /api/account-claim/candidates              — claim-pending
 *   POST   /api/account-claim/confirm                 — claim-pending
 *   POST   /api/account-claim/decline                 — claim-pending
 *   POST   /api/account-claim/by-password             — claim-pending
 *   POST   /api/account-claim/request-staff-review    — claim-pending
 *   GET    /api/account-claim/legacy                  — user
 *   POST   /api/account-claim/legacy/request          — user
 *   GET    /api/staff/account-claim/queue             — staff
 *   POST   /api/staff/account-claim/:requestId/approve — staff
 *   POST   /api/staff/account-claim/:requestId/deny   — staff
 *
 * Auth model: claim endpoints validate a `cfp_claim` JWT cookie (scope='claim').
 * The session middleware deliberately does NOT honor cfp_claim — these routes
 * verify it inline so a stray cookie can never escalate to a session.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errors as JoseErrors } from 'jose';
import { ok } from '../lib/response.js';
import {
  ApiNotFoundError,
  ApiValidationError,
  ConflictError,
  ForbiddenError,
  UnauthenticatedError,
} from '../lib/errors.js';
import { requireAuth } from '../auth/guards.js';
import { verifyClaimPending } from '../auth/jwt.js';
import {
  clearClaimCookie,
  setSessionCookies,
} from '../auth/cookies.js';
import { mintSessionFor } from '../auth/issue.js';
import type { SessionMeta } from '../auth/session-metadata.js';
import { buildTransactionOptions } from '../store/commit-meta.js';

const CLAIM_TOKEN_INVALID = 'claim_token_invalid';

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return (forwarded.split(',')[0] ?? '').trim();
  }
  return request.socket?.remoteAddress ?? 'unknown';
}

async function persistSession(
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

async function readClaim(
  fastify: FastifyInstance,
  request: FastifyRequest,
): Promise<ReturnType<typeof verifyClaimPending> extends Promise<infer T> ? T : never> {
  const token = request.cookies['cfp_claim'];
  if (!token) {
    throw new UnauthenticatedError('Claim token missing', CLAIM_TOKEN_INVALID);
  }
  try {
    return await verifyClaimPending(token, fastify.config.CFP_JWT_SIGNING_KEY);
  } catch (err) {
    if (
      err instanceof JoseErrors.JWTExpired ||
      err instanceof JoseErrors.JWTInvalid ||
      err instanceof JoseErrors.JWSInvalid ||
      err instanceof JoseErrors.JWSSignatureVerificationFailed
    ) {
      throw new UnauthenticatedError('Claim token invalid', CLAIM_TOKEN_INVALID);
    }
    throw err;
  }
}

async function finalizeAutoClaim(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  personId: string,
  accountLevel: 'user' | 'staff' | 'administrator',
): Promise<void> {
  const minted = await mintSessionFor(
    personId,
    accountLevel,
    fastify.config.CFP_JWT_SIGNING_KEY,
  );
  setSessionCookies(
    reply,
    { access: minted.accessToken, refresh: minted.refreshToken },
    fastify.config.NODE_ENV,
  );
  await persistSession(fastify, request, minted.refreshJti, personId);
  clearClaimCookie(reply);
}

export async function accountClaimRoutes(fastify: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // GET /api/account-claim/candidates
  // ---------------------------------------------------------------------------
  fastify.get(
    '/api/account-claim/candidates',
    {
      schema: {
        tags: ['account-claim'],
        summary: 'List candidate legacy Persons for the current claim flow',
      },
    },
    async (request) => {
      const claims = await readClaim(fastify, request);
      const payload = await fastify.services.accountClaim.buildCandidateSummaries(claims);
      return ok(payload);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/account-claim/confirm
  // ---------------------------------------------------------------------------
  fastify.post(
    '/api/account-claim/confirm',
    {
      schema: {
        tags: ['account-claim'],
        summary: 'Confirm an email-match candidate and link the GitHub identity',
        body: {
          type: 'object',
          required: ['personId'],
          properties: { personId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const claims = await readClaim(fastify, request);
      const { personId } = request.body as { personId: string };

      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          action: 'account-claim.confirm',
          subjectType: 'person',
          subjectId: personId,
          responseCode: 200,
        }),
        async (tx) => fastify.services.accountClaim.confirm(tx, claims, personId),
      );

      const outcome = result.value;
      if (!outcome.ok) {
        if (outcome.code === 'not_a_candidate') {
          throw new ForbiddenError('Not a candidate for this claim', 'not_a_candidate');
        }
        if (outcome.code === 'email_match_required') {
          throw new ForbiddenError('Email match required', 'email_match_required');
        }
        // already_claimed → 409
        throw new ConflictError('Candidate already claimed', 'already_claimed');
      }

      outcome.result.stateApply.apply(fastify.inMemoryState, fastify.fts);

      await finalizeAutoClaim(
        fastify,
        request,
        reply,
        outcome.result.person.id,
        outcome.result.person.accountLevel,
      );

      return reply.code(200).send(
        ok({ person: outcome.result.person, accountLevel: outcome.result.person.accountLevel }),
      );
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/account-claim/decline
  // ---------------------------------------------------------------------------
  fastify.post(
    '/api/account-claim/decline',
    {
      schema: {
        tags: ['account-claim'],
        summary: 'Decline all candidates; create a fresh Person',
      },
    },
    async (request, reply) => {
      const claims = await readClaim(fastify, request);

      const result = await fastify.store.transact(
        {
          ...buildTransactionOptions({
            request,
            action: 'account-claim.decline',
            subjectType: 'person',
            responseCode: 201,
          }),
          writeOrder: 'private-first',
        },
        async (tx) => fastify.services.accountClaim.decline(tx, claims),
      );

      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);

      await finalizeAutoClaim(
        fastify,
        request,
        reply,
        result.value.person.id,
        result.value.person.accountLevel,
      );

      return reply.code(201).send(
        ok({ person: result.value.person, accountLevel: result.value.person.accountLevel }),
      );
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/account-claim/by-password
  // ---------------------------------------------------------------------------
  fastify.post(
    '/api/account-claim/by-password',
    {
      schema: {
        tags: ['account-claim'],
        summary: 'Verify legacy slug + password to claim',
        body: {
          type: 'object',
          required: ['slug', 'password'],
          properties: {
            slug: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const claims = await readClaim(fastify, request);
      const { slug, password } = request.body as { slug: string; password: string };

      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          action: 'account-claim.by-password',
          subjectType: 'person',
          subjectSlug: slug,
          responseCode: 200,
        }),
        async (tx) => fastify.services.accountClaim.byPassword(tx, claims, slug, password),
      );

      const outcome = result.value;
      if (!outcome.ok) {
        // Uniform 401 for any failure — verifier collapses
        // wrong-password / unknown-format / internal-error into a
        // single `wrong_password` reason per
        // specs/behaviors/password-hash-rotation.md.
        throw new UnauthenticatedError(
          'Invalid credentials',
          'claim_credentials_invalid',
        );
      }

      outcome.result.stateApply.apply(fastify.inMemoryState, fastify.fts);

      await finalizeAutoClaim(
        fastify,
        request,
        reply,
        outcome.result.person.id,
        outcome.result.person.accountLevel,
      );

      return reply.code(200).send(
        ok({ person: outcome.result.person, accountLevel: outcome.result.person.accountLevel }),
      );
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/account-claim/request-staff-review
  // ---------------------------------------------------------------------------
  fastify.post(
    '/api/account-claim/request-staff-review',
    {
      schema: {
        tags: ['account-claim'],
        summary: 'Submit a free-form claim request for staff review',
        body: {
          type: 'object',
          required: ['claimedSlug', 'evidence'],
          properties: {
            claimedSlug: { type: 'string', minLength: 1, maxLength: 100 },
            evidence: { type: 'string', minLength: 1, maxLength: 5000 },
          },
        },
      },
    },
    async (request, reply) => {
      const claims = await readClaim(fastify, request);
      const { claimedSlug, evidence } = request.body as {
        claimedSlug: string;
        evidence: string;
      };

      await fastify.store.transact(
        {
          ...buildTransactionOptions({
            request,
            action: 'account-claim.request-staff-review',
            subjectType: 'account-claim-request',
            // Note: claimedSlug intentionally omitted from trailers — slug
            // existence shouldn't leak via the public commit log.
            responseCode: 202,
          }),
          writeOrder: 'private-first',
        },
        async (tx) =>
          fastify.services.accountClaim.requestStaffReview(tx, claims, claimedSlug, evidence),
      );

      return reply.code(202).send(ok({ delivered: true }));
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/account-claim/legacy — post-onboarding search
  // ---------------------------------------------------------------------------
  fastify.get(
    '/api/account-claim/legacy',
    {
      schema: {
        tags: ['account-claim'],
        summary: 'Post-onboarding: search for a legacy account to claim',
        querystring: {
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request) => {
      requireAuth(request, ['user']);
      const { q } = request.query as { q: string };
      const requesterId = request.session.personId ?? request.session.person!.id;
      const candidate = await fastify.services.accountClaim.legacySearch(q, requesterId);
      return ok({ candidates: candidate ? [candidate] : [] });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/account-claim/legacy/request — post-onboarding staff review
  // ---------------------------------------------------------------------------
  fastify.post(
    '/api/account-claim/legacy/request',
    {
      schema: {
        tags: ['account-claim'],
        summary: 'Post-onboarding: submit a merge request to staff',
        body: {
          type: 'object',
          required: ['claimedSlug', 'evidence'],
          properties: {
            claimedSlug: { type: 'string', minLength: 1, maxLength: 100 },
            evidence: { type: 'string', minLength: 1, maxLength: 5000 },
          },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, ['user']);
      const { claimedSlug, evidence } = request.body as {
        claimedSlug: string;
        evidence: string;
      };
      const requester = request.session.person;
      if (!requester) {
        throw new UnauthenticatedError('Authentication required');
      }
      if (!requester.githubUserId) {
        throw new ApiValidationError(
          'Requester has no GitHub identity to link',
          { githubUserId: 'missing' },
        );
      }

      await fastify.store.transact(
        {
          ...buildTransactionOptions({
            request,
            action: 'account-claim.legacy-request',
            subjectType: 'account-claim-request',
            responseCode: 202,
          }),
          writeOrder: 'private-first',
        },
        async (tx) =>
          fastify.services.accountClaim.legacyRequest(
            tx,
            requester,
            requester.githubUserId!,
            claimedSlug,
            evidence,
          ),
      );

      return reply.code(202).send(ok({ delivered: true }));
    },
  );

  // ---------------------------------------------------------------------------
  // Staff queue endpoints
  // ---------------------------------------------------------------------------

  fastify.get(
    '/api/staff/account-claim/queue',
    {
      schema: {
        tags: ['account-claim'],
        summary: 'List open account-claim requests (staff only)',
      },
    },
    async (request) => {
      requireAuth(request, ['staff']);
      const items = await fastify.services.accountClaim.staffQueue();
      return ok(
        items.map((r) => ({
          requestId: r.id,
          type: r.type,
          claimedSlug: r.claimedSlug,
          claimedPersonId: r.claimedPersonId,
          requesterGithubLogin: r.requesterGithubLogin,
          requesterPersonId: r.requesterPersonId,
          evidence: r.evidence,
          submittedAt: r.submittedAt,
        })),
      );
    },
  );

  fastify.post(
    '/api/staff/account-claim/:requestId/approve',
    {
      schema: {
        tags: ['account-claim'],
        summary: 'Approve a pending account-claim request (staff only)',
        params: {
          type: 'object',
          required: ['requestId'],
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: { reason: { type: 'string', maxLength: 2000 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, ['staff']);
      const { requestId } = request.params as { requestId: string };
      const body = (request.body ?? {}) as { reason?: string };
      const staffPersonId = request.session.personId ?? request.session.person!.id;

      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          action: 'account-claim.approve',
          subjectType: 'account-claim-request',
          subjectId: requestId,
          responseCode: 200,
          extraTrailers: body.reason ? { Reason: body.reason } : undefined,
        }),
        async (tx) =>
          fastify.services.accountClaim.staffApprove(
            tx,
            requestId,
            staffPersonId,
            body.reason ?? null,
          ),
      );

      const outcome = result.value;
      if (!outcome.ok) {
        if (outcome.code === 'not_found') {
          throw new ApiNotFoundError(`Claim request ${requestId} not found`);
        }
        if (outcome.code === 'already_reviewed') {
          throw new ConflictError('Claim request already reviewed', 'already_reviewed');
        }
        if (outcome.code === 'no_claimed_person') {
          throw new ApiValidationError(
            'No claimed Person resolves for this request',
            { claimedSlug: 'unresolved' },
          );
        }
        if (outcome.code === 'requester_missing') {
          throw new ApiValidationError('Requester Person missing', { requesterPersonId: 'missing' });
        }
        // already_claimed
        throw new ConflictError(
          'Target Person already linked to a GitHub identity',
          'already_claimed',
        );
      }

      outcome.result.stateApply.apply(fastify.inMemoryState, fastify.fts);
      if (outcome.result.mergeApply) {
        outcome.result.mergeApply.hardRemovePersonFromState(fastify.inMemoryState, fastify.fts);
      }

      return reply.code(200).send(
        ok({
          requestId: outcome.result.request.id,
          status: outcome.result.request.status,
          person: outcome.result.person,
        }),
      );
    },
  );

  fastify.post(
    '/api/staff/account-claim/:requestId/deny',
    {
      schema: {
        tags: ['account-claim'],
        summary: 'Deny a pending account-claim request (staff only)',
        params: {
          type: 'object',
          required: ['requestId'],
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: { reason: { type: 'string', maxLength: 2000 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, ['staff']);
      const { requestId } = request.params as { requestId: string };
      const body = (request.body ?? {}) as { reason?: string };
      const staffPersonId = request.session.personId ?? request.session.person!.id;

      const result = await fastify.store.transact(
        {
          ...buildTransactionOptions({
            request,
            action: 'account-claim.deny',
            subjectType: 'account-claim-request',
            subjectId: requestId,
            responseCode: 200,
            extraTrailers: body.reason ? { Reason: body.reason } : undefined,
          }),
          writeOrder: 'private-first',
        },
        async (tx) =>
          fastify.services.accountClaim.staffDeny(
            tx,
            requestId,
            staffPersonId,
            body.reason ?? null,
          ),
      );

      const outcome = result.value;
      if (!outcome.ok) {
        if (outcome.code === 'not_found') {
          throw new ApiNotFoundError(`Claim request ${requestId} not found`);
        }
        throw new ConflictError('Claim request already reviewed', 'already_reviewed');
      }

      return reply.code(200).send(
        ok({
          requestId: outcome.result.request.id,
          status: outcome.result.request.status,
        }),
      );
    },
  );
}
