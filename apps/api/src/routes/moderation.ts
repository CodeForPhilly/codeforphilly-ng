/**
 * Moderation API — specs/api/moderation.md.
 *
 *   GET    /api/admin/members             — staff | agent:moderation:read
 *   GET    /api/admin/members/:slug       — staff | agent:moderation:read
 *   POST   /api/admin/members/:slug/vote  — staff | agent:moderation:vote
 *   DELETE /api/admin/members/:slug/vote  — agent:moderation:vote
 *   POST   /api/admin/members/:slug/purge — agent:moderation:purge
 *
 * Anyone else gets 404: like the other staff surfaces, the endpoints'
 * existence is not a signal. An agent reads the roster without emails and
 * its votes are staged (moderation.md → Agent callers, Agent votes).
 */
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { ok, paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { getCallerSession } from '../services/permissions.js';
import { buildTransactionOptions, withInlineTrailers } from '../store/commit-meta.js';
import { evidenceTrailer, validatePurgeBody, type AgentPurgeInput } from '../services/agent-purge.js';
import { agentCaller, moderationCaller } from '../auth/caller.js';
import type { MemberOrigin, VoteFilter } from '../services/moderation.js';
import { findOrphanPrivateData, purgeOrphanPrivateData } from '../services/private-orphans.js';

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
            vote: { type: 'string', enum: ['none', 'staged', 'spam', 'legit'] },
            origin: { type: 'string', enum: ['imported', 'signed-up'] },
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
      const caller = moderationCaller(request, 'moderation:read');
      const q = request.query as Record<string, unknown>;
      const result = await fastify.services.moderation.listMembers({
        q: q['q'] as string | undefined,
        vote: q['vote'] as VoteFilter | undefined,
        origin: q['origin'] as MemberOrigin | undefined,
        joinedAfter: q['joinedAfter'] as string | undefined,
        joinedBefore: q['joinedBefore'] as string | undefined,
        includeDeactivated: q['includeDeactivated'] as boolean | undefined,
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
        viewer: caller.kind,
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
        summary: "One member's footprint on the site and every vote on record",
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      },
    },
    async (request) => {
      const caller = moderationCaller(request, 'moderation:read');
      const { slug } = request.params as { slug: string };
      const moderation = fastify.services.moderation;
      const person =
        caller.kind === 'agent'
          ? await fastify.services.people.get(slug, undefined, { moderationReader: true })
          : await fastify.services.people.get(slug, getCallerSession(request));
      const footprint = moderation.footprint(slug);
      const row = await moderation.memberRow(slug, caller.kind);
      if (!person || !footprint || !row) throw new ApiNotFoundError(`Person '${slug}' not found`);
      return ok({
        ...row,
        person,
        footprint,
        votes: moderation.votes(slug),
        earlierVotes: moderation.earlierVotes(slug),
        earlierPurges: moderation.earlierPurges(slug),
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
            flags: { type: 'array', items: { type: 'string' } },
          },
          required: ['verdict'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const caller = moderationCaller(request, 'moderation:vote');
      const { slug } = request.params as { slug: string };
      const body = request.body as { verdict: 'spam' | 'legit'; reasoning?: string; flags?: string[] };
      if (caller.kind === 'staff' && body.flags !== undefined) {
        throw new ApiValidationError('Flags are for agent votes', { flags: 'not accepted on a staff vote' });
      }
      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          session: caller.session,
          action: 'moderation.vote',
          subjectType: 'person',
          subjectSlug: slug,
          responseCode: 200,
          summary: `${body.verdict}${body.reasoning ? `: ${body.reasoning}` : ''}`,
        }),
        async (tx) => fastify.services.moderationWrite.castVote(tx, slug, caller.session, body),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      const person =
        caller.kind === 'agent'
          ? await fastify.services.people.get(result.value.person.slug, undefined, { moderationReader: true })
          : await fastify.services.people.get(result.value.person.slug, getCallerSession(request));
      return ok({
        person,
        vote: result.value.vote,
        latestVote: fastify.services.moderation.latestHumanVote(slug),
        stagedVote: fastify.services.moderation.stagedVote(slug),
        purgeAfter: (await fastify.services.moderation.memberRow(slug, caller.kind))?.purgeAfter ?? null,
      });
    },
  );

  // DELETE /api/admin/members/:slug/vote — an agent takes back its own vote.
  fastify.delete(
    '/api/admin/members/:slug/vote',
    {
      schema: {
        tags: ['moderation'],
        summary: "Withdraw the calling agent's own vote (agents only)",
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      },
    },
    async (request) => {
      const caller = agentCaller(request, 'moderation:vote');
      const { slug } = request.params as { slug: string };
      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          session: caller.session,
          action: 'moderation.vote-withdraw',
          subjectType: 'person',
          subjectSlug: slug,
          responseCode: 200,
        }),
        async (tx) => fastify.services.moderationWrite.withdrawVote(tx, slug, caller.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      return ok({
        person: await fastify.services.people.get(slug, undefined, { moderationReader: true }),
        stagedVote: fastify.services.moderation.stagedVote(slug),
      });
    },
  );

  // POST /api/admin/members/:slug/purge — an agent purges a new member who
  // posted spam (moderation.md → Agent purges). One commit per purge.
  fastify.post(
    '/api/admin/members/:slug/purge',
    {
      schema: {
        tags: ['moderation'],
        summary: 'Purge a new member who posted spam, citing the evidence (agents only)',
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
        body: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
            flags: { type: 'array', items: { type: 'string' } },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  record: { type: 'string' },
                  field: { type: 'string' },
                  project: { type: 'string' },
                  number: { type: 'integer' },
                  slug: { type: 'string' },
                  roleId: { type: 'string' },
                },
                required: ['record'],
                additionalProperties: false,
              },
            },
            dryRun: { type: 'boolean' },
          },
          required: ['reason', 'evidence'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const caller = agentCaller(request, 'moderation:purge');
      const { slug } = request.params as { slug: string };
      const input = request.body as AgentPurgeInput;
      const service = fastify.services.agentPurge;
      const member = service.memberOr404(slug);
      const body = validatePurgeBody(member.slug, input);
      const head = async (): Promise<string> => (await fastify.publicRepo.resolveRef('HEAD')) ?? 'unknown';

      if (input.dryRun) {
        // Every check, under the write lock, and nothing written.
        const preview = await fastify.publicRepo.withLock(async () => {
          const now = new Date();
          const { deleted } = await service.check(caller.agent.person, caller.agent.grant.id, member, body, now);
          const purge = service.record(uuidv7(), caller.agent.person, caller.agent.grant.id, member, body, await head(), now);
          return { purge, deleted };
        });
        return ok({ ...preview, dryRun: true });
      }

      const purgeId = uuidv7();
      const opts = withInlineTrailers(
        buildTransactionOptions({
          request,
          session: caller.session,
          action: 'person.purge',
          subjectType: 'person',
          subjectId: member.id,
          subjectSlug: member.slug,
          responseCode: 200,
          summary: body.reason,
          extraTrailers: { 'Purge-Id': purgeId },
        }),
        body.evidence.map((e) => ['Evidence', evidenceTrailer(e)] as const),
      );
      const result = await fastify.store.transact(opts, async (tx) =>
        service.purge(tx, caller.session, member, body, purgeId, head),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      await fastify.sessionMetadata.removeAllFor(member.id, fastify.store.private);
      return ok({ purge: result.value.purge, deleted: result.value.deleted, dryRun: false });
    },
  );

  // POST /api/admin/private-data/purge-orphans (administrator only)
  // Spec: specs/api/moderation.md → POST /api/admin/private-data/purge-orphans
  fastify.post(
    '/api/admin/private-data/purge-orphans',
    {
      schema: {
        tags: ['admin'],
        summary: 'Delete private data of people with no public record (admin only)',
        body: {
          type: 'object',
          properties: { apply: { type: 'boolean' } },
          required: ['apply'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      if (request.session.accountLevel !== 'administrator') throw new ApiNotFoundError('Not found');
      const { apply } = request.body as { apply: boolean };
      // Under the write lock: account creation writes the private profile
      // before the public record, and must never look orphaned mid-write.
      const found = await fastify.publicRepo.withLock(async () => {
        const publicIds = new Set(fastify.inMemoryState.people.keys());
        const result = await findOrphanPrivateData(publicIds, fastify.store.private, fastify.sessionMetadata);
        if (apply && result.personIds.length > 0) {
          await purgeOrphanPrivateData(result, fastify.store.private, fastify.sessionMetadata);
        }
        return result;
      });
      const { personIds, ...counts } = found;
      request.log.info({ apply, orphanPeople: personIds.length, ...counts }, 'private orphan purge');
      return ok({ applied: apply, orphanPeople: personIds.length, ...counts });
    },
  );
}
