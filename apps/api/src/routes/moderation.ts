/**
 * Moderation API — specs/api/moderation.md.
 *
 *   GET  /api/admin/members             — staff roster, newest signup first
 *   GET  /api/admin/members/:slug       — one member's footprint + human votes
 *   POST /api/admin/members/:slug/vote  — record the caller's spam/legit verdict
 *
 * Every route is staff/admin only and answers 404 to anyone else: like the
 * other staff surfaces, the endpoints' existence is not a signal.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ok, paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { getCallerSession } from '../services/permissions.js';
import { buildTransactionOptions } from '../store/commit-meta.js';
import type { VoteFilter } from '../services/moderation.js';

function requireStaffOr404(request: FastifyRequest): void {
  const level = request.session.accountLevel;
  if (level !== 'staff' && level !== 'administrator') {
    throw new ApiNotFoundError('Not found');
  }
}

export async function moderationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/admin/members',
    {
      schema: {
        tags: ['moderation'],
        summary: 'Staff roster of members, newest signup first',
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            vote: { type: 'string', enum: ['none', 'spam', 'legit'] },
            joinedAfter: { type: 'string' },
            joinedBefore: { type: 'string' },
            includeDeactivated: { type: 'boolean' },
            sort: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      requireStaffOr404(request);
      const q = request.query as Record<string, unknown>;
      const result = await fastify.services.moderation.listMembers({
        q: q['q'] as string | undefined,
        vote: q['vote'] as VoteFilter | undefined,
        joinedAfter: q['joinedAfter'] as string | undefined,
        joinedBefore: q['joinedBefore'] as string | undefined,
        includeDeactivated: q['includeDeactivated'] as boolean | undefined,
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      });
      if ('error' in result) {
        throw new ApiValidationError('Unknown sort key', { sort: 'unknown sort key' });
      }
      return paginated(result.items, {
        page: result.page,
        perPage: result.perPage,
        totalItems: result.totalItems,
        totalPages: Math.max(1, Math.ceil(result.totalItems / result.perPage)),
      });
    },
  );

  fastify.get(
    '/api/admin/members/:slug',
    {
      schema: {
        tags: ['moderation'],
        summary: "One member's footprint on the site and every human vote",
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      },
    },
    async (request) => {
      requireStaffOr404(request);
      const { slug } = request.params as { slug: string };
      const caller = getCallerSession(request);
      const person = await fastify.services.people.get(slug, caller);
      const footprint = fastify.services.moderation.footprint(slug);
      if (!person || !footprint) throw new ApiNotFoundError(`Person '${slug}' not found`);
      return ok({
        person,
        footprint,
        votes: fastify.services.moderation.humanVotes(slug),
      });
    },
  );

  fastify.post(
    '/api/admin/members/:slug/vote',
    {
      schema: {
        tags: ['moderation'],
        summary: "Record the caller's spam / not-spam verdict on a member",
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
        body: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['spam', 'legit'] },
            reasoning: { type: 'string', maxLength: 1000 },
          },
          required: ['verdict'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      requireStaffOr404(request);
      const { slug } = request.params as { slug: string };
      const body = request.body as { verdict: 'spam' | 'legit'; reasoning?: string };
      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          action: 'moderation.vote',
          subjectType: 'person',
          subjectSlug: slug,
          responseCode: 200,
          summary: `${body.verdict}${body.reasoning ? `: ${body.reasoning}` : ''}`,
        }),
        async (tx) => fastify.services.moderationWrite.castVote(tx, slug, request.session, body),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      const caller = getCallerSession(request);
      const person = await fastify.services.people.get(result.value.person.slug, caller);
      return ok({
        person,
        vote: result.value.vote,
        latestVote: fastify.services.moderation.latestHumanVote(slug),
      });
    },
  );
}
