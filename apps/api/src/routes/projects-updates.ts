/**
 * Project update routes:
 *   GET /api/projects/:slug/updates
 *   GET /api/projects/:slug/updates/:number
 *   GET /api/project-updates (global feed)
 */
import type { FastifyInstance } from 'fastify';
import { ok, paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { getCallerSession } from '../lib/session.js';

export async function projectUpdateRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/projects/:slug/updates
  fastify.get(
    '/api/projects/:slug/updates',
    {
      schema: {
        tags: ['project-updates'],
        summary: "List a project's updates",
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

      const result = fastify.services.projectUpdates.listForProject(slug, opts, caller);

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

  // GET /api/projects/:slug/updates/:number
  fastify.get(
    '/api/projects/:slug/updates/:number',
    {
      schema: {
        tags: ['project-updates'],
        summary: 'Fetch a single project update',
        params: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            number: { type: 'integer', minimum: 1 },
          },
          required: ['slug', 'number'],
        },
      },
    },
    async (request) => {
      const { slug, number } = request.params as { slug: string; number: number };
      const caller = getCallerSession(request);

      const result = fastify.services.projectUpdates.getForProject(slug, number, caller);

      if (!result) throw new ApiNotFoundError('Update not found');
      if ('error' in result) {
        if (result.error === 'not_found') throw new ApiNotFoundError(`Project '${slug}' not found`);
        throw new ApiValidationError('Invalid parameter');
      }

      return ok(result);
    },
  );

  // GET /api/project-updates (global feed)
  fastify.get(
    '/api/project-updates',
    {
      schema: {
        tags: ['project-updates'],
        summary: 'Global feed of recent project updates',
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

      const result = fastify.services.projectUpdates.globalFeed(opts, caller);

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
}
