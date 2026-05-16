/**
 * Help-wanted routes:
 *   GET /api/projects/:slug/help-wanted
 *   GET /api/help-wanted (global browse)
 */
import type { FastifyInstance } from 'fastify';
import { paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { getCallerSession } from '../lib/session.js';

export async function helpWantedRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/projects/:slug/help-wanted
  fastify.get(
    '/api/projects/:slug/help-wanted',
    {
      schema: {
        tags: ['help-wanted'],
        summary: "List a project's help-wanted roles",
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'filled', 'closed'] },
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
        status: q['status'] as string | undefined,
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      };

      const result = fastify.services.helpWanted.listForProject(slug, opts, caller);

      if ('error' in result) {
        if (result.error === 'not_found') throw new ApiNotFoundError(`Project '${slug}' not found`);
        if (result.error === 'invalid_sort') {
          throw new ApiValidationError('Unknown sort key', { sort: 'unknown sort key' });
        }
        throw new ApiValidationError('Invalid filter parameter');
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

  // GET /api/help-wanted (global browse)
  fastify.get(
    '/api/help-wanted',
    {
      schema: {
        tags: ['help-wanted'],
        summary: 'Cross-project browse of help-wanted roles',
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'filled', 'closed'] },
            tag: { type: 'array', items: { type: 'string' } },
            commitmentMax: { type: 'integer', minimum: 0 },
            q: { type: 'string' },
            sort: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const q = request.query as Record<string, unknown>;
      const caller = getCallerSession(request);

      const opts = {
        status: q['status'] as string | undefined,
        tag: q['tag'] as string[] | undefined,
        commitmentMax: q['commitmentMax'] as number | undefined,
        q: q['q'] as string | undefined,
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      };

      const result = fastify.services.helpWanted.globalBrowse(opts, caller);

      if ('error' in result) {
        if (result.error === 'invalid_sort') {
          throw new ApiValidationError('Unknown sort key', { sort: 'unknown sort key' });
        }
        throw new ApiValidationError('Invalid filter parameter');
      }

      const page = Math.max(1, opts.page ?? 1);
      const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));

      return {
        ...paginated(result.items, {
          page,
          perPage,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / perPage),
        }),
        metadata: {
          timestamp: new Date().toISOString(),
          page,
          perPage,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / perPage),
          facets: result.facets,
        },
      };
    },
  );
}
