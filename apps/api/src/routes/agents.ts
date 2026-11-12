/**
 * Agents API — specs/api/agents.md.
 *
 *   GET  /api/admin/agents                                — staff
 *   POST /api/admin/agents                                — administrator
 *   POST /api/admin/agents/:slug/grants                   — administrator
 *   POST /api/admin/agents/:slug/grants/:id/revoke        — administrator
 *   POST /api/admin/agents/:slug/withdraw-votes           — staff
 *
 * Anyone else (agents included) gets 404, like the rest of /api/admin. Every
 * write is a public commit by the calling administrator or staff member;
 * the token is in the mint response only, never in a commit or a log.
 */
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';

import { administratorCaller, staffCaller } from '../auth/caller.js';
import { ok } from '../lib/response.js';
import { buildTransactionOptions } from '../store/commit-meta.js';
import type { GrantInput } from '../services/agents.js';

const GRANT_BODY = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    scopes: { type: 'array', items: { type: 'string' } },
    expiresInDays: { type: 'integer' },
  },
  required: ['label', 'scopes'],
  additionalProperties: false,
} as const;

export async function agentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/admin/agents',
    { schema: { tags: ['agents'], summary: 'Every agent account, its grants and recent purges (staff)' } },
    async (request) => {
      staffCaller(request);
      return ok(fastify.services.agents.list());
    },
  );

  fastify.post(
    '/api/admin/agents',
    {
      schema: {
        tags: ['agents'],
        summary: 'Create an agent account with its first grant (administrator)',
        body: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            fullName: { type: 'string' },
            bio: { type: 'string' },
            grant: GRANT_BODY,
          },
          required: ['slug', 'fullName', 'bio'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const session = administratorCaller(request);
      // `grant` is required; the service says so by name (422 fields.grant).
      const body = request.body as { slug: string; fullName: string; bio: string; grant: GrantInput };
      const slug = body.slug.trim().toLowerCase();
      const ids = { personId: uuidv7(), grantId: uuidv7() };
      const result = await fastify.store.transact(
        {
          ...buildTransactionOptions({
            request,
            action: 'agent.create',
            subjectType: 'person',
            subjectId: ids.personId,
            subjectSlug: slug,
            responseCode: 201,
            extraTrailers: { 'Grant-Id': ids.grantId },
          }),
          // The token hash must land before the grant is public.
          writeOrder: 'private-first',
        },
        async (tx) => fastify.services.agents.create(tx, session.person!.slug, body, ids),
        (value) => value.stateApply.apply(fastify.inMemoryState, fastify.fts),
      );
      const { person, grant, token } = result.value;
      return reply.code(201).send(
        ok({
          person: await fastify.services.people.get(person.slug, undefined),
          grant: fastify.services.agents.grantView(grant),
          token,
        }),
      );
    },
  );

  fastify.post(
    '/api/admin/agents/:slug/grants',
    {
      schema: {
        tags: ['agents'],
        summary: 'Mint a grant for an agent; the token is returned once (administrator)',
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
        body: GRANT_BODY,
      },
    },
    async (request, reply) => {
      const session = administratorCaller(request);
      const { slug } = request.params as { slug: string };
      const agent = fastify.services.agents.agentOr404(slug);
      const grantId = uuidv7();
      const result = await fastify.store.transact(
        {
          ...buildTransactionOptions({
            request,
            action: 'agent.grant',
            subjectType: 'person',
            subjectId: agent.id,
            subjectSlug: slug,
            responseCode: 201,
            extraTrailers: { 'Grant-Id': grantId },
          }),
          writeOrder: 'private-first',
        },
        async (tx) => fastify.services.agents.mint(tx, slug, session.person!.slug, request.body as GrantInput, grantId),
        (value) => value.stateApply.apply(fastify.inMemoryState, fastify.fts),
      );
      return reply
        .code(201)
        .send(ok({ grant: fastify.services.agents.grantView(result.value.grant), token: result.value.token }));
    },
  );

  fastify.post(
    '/api/admin/agents/:slug/grants/:id/revoke',
    {
      schema: {
        tags: ['agents'],
        summary: "Revoke a grant at once, optionally withdrawing the agent's staged votes (administrator)",
        params: {
          type: 'object',
          properties: { slug: { type: 'string' }, id: { type: 'string' } },
          required: ['slug', 'id'],
        },
        body: {
          type: ['object', 'null'],
          properties: { withdrawVotes: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      administratorCaller(request);
      const { slug, id } = request.params as { slug: string; id: string };
      const withdrawVotes = (request.body as { withdrawVotes?: boolean } | null)?.withdrawVotes === true;
      const existing = fastify.services.agents.grantOr404(slug, id);
      if (existing.revokedAt && !withdrawVotes) return ok({ grant: fastify.services.agents.grantView(existing) });
      const agent = fastify.services.agents.agentOr404(slug);
      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          action: 'agent.revoke',
          subjectType: 'person',
          subjectId: agent.id,
          subjectSlug: slug,
          responseCode: 200,
          extraTrailers: { 'Grant-Id': id, ...(withdrawVotes ? { 'Withdraw-Votes': 'true' } : {}) },
        }),
        async (tx) => {
          // A token that may be compromised: revoke, and withdraw what it
          // staged, in one commit (specs/api/agents.md → revoke).
          const revoked = await fastify.services.agents.revoke(tx, slug, id);
          if (!withdrawVotes) return { ...revoked, withdrawn: null };
          const withdrawn = await fastify.services.moderationWrite.withdrawAll(tx, slug, null, revoked.stateApply);
          return { ...revoked, withdrawn };
        },
        // Immediate: the next request with this token is refused.
        (value) => value.stateApply.apply(fastify.inMemoryState, fastify.fts),
      );
      const { grant, withdrawn } = result.value;
      return ok({
        grant: fastify.services.agents.grantView(grant),
        ...(withdrawn ? { withdrawn: withdrawn.withdrawn, reactivated: withdrawn.reactivated } : {}),
      });
    },
  );

  fastify.post(
    '/api/admin/agents/:slug/withdraw-votes',
    {
      schema: {
        tags: ['agents'],
        summary: "Withdraw every vote an agent has staged, in one commit (staff)",
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
        body: {
          type: ['object', 'null'],
          properties: { since: { type: 'string', format: 'date-time' } },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      staffCaller(request);
      const { slug } = request.params as { slug: string };
      const agent = fastify.services.agents.agentOr404(slug);
      const since = (request.body as { since?: string } | null)?.since ?? null;
      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          action: 'agent.withdraw-votes',
          subjectType: 'person',
          subjectId: agent.id,
          subjectSlug: slug,
          responseCode: 200,
          ...(since ? { summary: `since ${since}` } : {}),
        }),
        async (tx) => fastify.services.moderationWrite.withdrawAll(tx, slug, since),
        (value) => value.stateApply.apply(fastify.inMemoryState, fastify.fts),
      );
      return ok({ withdrawn: result.value.withdrawn, reactivated: result.value.reactivated });
    },
  );
}
