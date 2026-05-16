/**
 * Project buzz routes:
 *   GET /api/projects/:slug/buzz
 *   GET /api/project-buzz (global feed)
 */
import type { FastifyInstance } from 'fastify';
import { paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { getCallerSession } from '../services/permissions.js';

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
}
