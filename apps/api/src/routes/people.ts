/**
 * People routes:
 *   GET /api/people
 *   GET /api/people/:slug
 */
import type { FastifyInstance } from 'fastify';
import { ok, paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { getCallerSession } from '../lib/session.js';

export async function peopleRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/people
  fastify.get(
    '/api/people',
    {
      schema: {
        tags: ['people'],
        summary: 'Browse members',
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            tag: { type: 'array', items: { type: 'string' } },
            accountLevel: { type: 'string' },
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
        q: q['q'] as string | undefined,
        tag: q['tag'] as string[] | undefined,
        accountLevel: q['accountLevel'] as string | undefined,
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      };

      const result = fastify.services.people.list(opts, caller);

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

  // GET /api/people/:slug
  fastify.get(
    '/api/people/:slug',
    {
      schema: {
        tags: ['people'],
        summary: 'Fetch a single person profile',
        params: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
          },
          required: ['slug'],
        },
      },
    },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const caller = getCallerSession(request);

      const person = fastify.services.people.get(slug, caller);
      if (!person) {
        throw new ApiNotFoundError(`Person '${slug}' not found`);
      }

      return ok(person);
    },
  );
}
