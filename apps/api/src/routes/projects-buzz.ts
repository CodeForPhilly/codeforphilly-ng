/**
 * Project buzz routes:
 *   GET    /api/projects/:slug/buzz
 *   GET    /api/project-buzz (global feed)
 *   POST   /api/projects/:slug/buzz
 *   PATCH  /api/projects/:slug/buzz/:buzzSlug
 *   DELETE /api/projects/:slug/buzz/:buzzSlug
 */
import type { FastifyInstance } from 'fastify';
import { ok, paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { getCallerSession } from '../services/permissions.js';
import { buildTransactionOptions } from '../store/commit-meta.js';
import { computeBuzzPermissions } from '../services/permissions.js';
import { serializeProjectBuzz } from '../services/serializers/project-buzz.js';

export async function projectBuzzRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/projects/:slug/buzz
  fastify.get(
    '/api/projects/:slug/buzz',
    {
      schema: {
        tags: ['project-buzz'],
        summary: "List a project's buzz",
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        querystring: {
          type: 'object',
          properties: {
            sort: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const q = request.query as Record<string, unknown>;
      const caller = getCallerSession(request);

      const opts = {
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      };

      const result = fastify.services.projectBuzz.listForProject(slug, opts, caller);

      if ('error' in result) {
        if (result.error === 'not_found') throw new ApiNotFoundError(`Project '${slug}' not found`);
        if (result.error === 'invalid_sort') {
          throw new ApiValidationError('Unknown sort key', { sort: 'unknown sort key' });
        }
        throw new ApiValidationError('Invalid parameter');
      }

      const page = Math.max(1, opts.page ?? 1);
      const perPage = Math.min(100, Math.max(1, opts.perPage ?? 20));

      return paginated(result.items, {
        page,
        perPage,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / perPage),
      });
    },
  );

  // GET /api/project-buzz (global feed)
  fastify.get(
    '/api/project-buzz',
    {
      schema: {
        tags: ['project-buzz'],
        summary: 'Global buzz feed',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
            since: { type: 'string' },
            tag: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const q = request.query as Record<string, unknown>;
      const caller = getCallerSession(request);

      const opts = {
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
        since: q['since'] as string | undefined,
        tag: q['tag'] as string[] | undefined,
      };

      const result = fastify.services.projectBuzz.globalFeed(opts, caller);

      const page = Math.max(1, opts.page ?? 1);
      const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));

      return paginated(result.items, {
        page,
        perPage,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / perPage),
      });
    },
  );

  // POST /api/projects/:slug/buzz
  fastify.post('/api/projects/:slug/buzz', {
    schema: {
      tags: ['project-buzz'],
      summary: 'Log a buzz item',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      body: {
        type: 'object',
        properties: {
          headline: { type: 'string' },
          url: { type: 'string' },
          publishedAt: { type: 'string' },
          summary: { type: ['string', 'null'] },
          imageUpload: {
            type: ['object', 'null'],
            properties: { key: { type: 'string' } },
          },
        },
        required: ['headline', 'url', 'publishedAt'],
      },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const body = request.body as {
      headline: string; url: string; publishedAt: string;
      summary?: string | null; imageUpload?: { key: string } | null;
    };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'project-buzz.create',
        subjectType: 'project-buzz',
        subjectSlug: slug,
        responseCode: 201,
      }),
      async (tx) => fastify.services.projectBuzzWrite.create(tx, slug, body, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);

    const project = fastify.inMemoryState.projects.get(result.value.buzz.projectId)!;
    const postedBy = result.value.buzz.postedById
      ? (fastify.inMemoryState.people.get(result.value.buzz.postedById) ?? null)
      : null;
    const caller = getCallerSession(request);
    const permissions = computeBuzzPermissions(caller, result.value.buzz);

    reply.code(201);
    return ok(serializeProjectBuzz(result.value.buzz, { project, postedBy, permissions }));
  });

  // PATCH /api/projects/:slug/buzz/:buzzSlug
  fastify.patch('/api/projects/:slug/buzz/:buzzSlug', {
    schema: {
      tags: ['project-buzz'],
      summary: 'Edit a buzz item',
      params: {
        type: 'object',
        properties: { slug: { type: 'string' }, buzzSlug: { type: 'string' } },
        required: ['slug', 'buzzSlug'],
      },
      querystring: {
        type: 'object',
        properties: { regenerateSlug: { type: 'boolean' } },
        additionalProperties: false,
      },
      body: { type: 'object' },
    },
  }, async (request) => {
    const { slug, buzzSlug } = request.params as { slug: string; buzzSlug: string };
    const q = request.query as { regenerateSlug?: boolean };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = { ...body, regenerateSlug: q.regenerateSlug } as Parameters<
      typeof fastify.services.projectBuzzWrite.update
    >[3];

    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'project-buzz.edit',
        subjectType: 'project-buzz',
        subjectSlug: `${slug}/${buzzSlug}`,
        responseCode: 200,
      }),
      async (tx) =>
        fastify.services.projectBuzzWrite.update(tx, slug, buzzSlug, input, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    const project = fastify.inMemoryState.projects.get(result.value.buzz.projectId)!;
    const postedBy = result.value.buzz.postedById
      ? (fastify.inMemoryState.people.get(result.value.buzz.postedById) ?? null)
      : null;
    const caller = getCallerSession(request);
    const permissions = computeBuzzPermissions(caller, result.value.buzz);
    return ok(serializeProjectBuzz(result.value.buzz, { project, postedBy, permissions }));
  });

  // DELETE /api/projects/:slug/buzz/:buzzSlug
  fastify.delete('/api/projects/:slug/buzz/:buzzSlug', {
    schema: {
      tags: ['project-buzz'],
      summary: 'Delete a buzz item',
      params: {
        type: 'object',
        properties: { slug: { type: 'string' }, buzzSlug: { type: 'string' } },
        required: ['slug', 'buzzSlug'],
      },
    },
  }, async (request, reply) => {
    const { slug, buzzSlug } = request.params as { slug: string; buzzSlug: string };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'project-buzz.delete',
        subjectType: 'project-buzz',
        subjectSlug: `${slug}/${buzzSlug}`,
        responseCode: 204,
      }),
      async (tx) =>
        fastify.services.projectBuzzWrite.delete(tx, slug, buzzSlug, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    return reply.code(204).send();
  });

  // Avoid "unused import"
  void ApiNotFoundError;
  void ApiValidationError;
}
