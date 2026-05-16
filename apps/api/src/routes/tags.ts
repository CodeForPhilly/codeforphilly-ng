/**
 * Tag routes:
 *   GET /api/tags
 *   GET /api/tags/:handle
 *   GET /api/tags/:handle/projects
 *   GET /api/tags/:handle/people
 */
import type { FastifyInstance } from 'fastify';
import { ok, paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { getCallerSession } from '../services/permissions.js';

export async function tagRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/tags
  fastify.get(
    '/api/tags',
    {
      schema: {
        tags: ['tags'],
        summary: 'List tags',
        querystring: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            q: { type: 'string' },
            taggableType: { type: 'string' },
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

      const opts = {
        namespace: q['namespace'] as string | undefined,
        q: q['q'] as string | undefined,
        taggableType: q['taggableType'] as string | undefined,
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      };

      const result = fastify.services.tags.list(opts);

      if ('error' in result) {
        if (result.error === 'invalid_sort') {
          throw new ApiValidationError('Unknown sort key', { sort: 'unknown sort key' });
        }
        throw new ApiValidationError('Invalid filter parameter');
      }

      const page = Math.max(1, opts.page ?? 1);
      const perPage = Math.min(100, Math.max(1, opts.perPage ?? 100));

      return paginated(result.items, {
        page,
        perPage,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / perPage),
      });
    },
  );

  // GET /api/tags/:handle
  // Note: handle is namespace.slug — fastify treats the dot literally in params
  // We use a wildcard and split ourselves to support the dot.
  fastify.get(
    '/api/tags/:handle',
    {
      schema: {
        tags: ['tags'],
        summary: 'Fetch a single tag',
        params: {
          type: 'object',
          properties: {
            handle: { type: 'string' },
          },
          required: ['handle'],
        },
      },
    },
    async (request) => {
      const { handle } = request.params as { handle: string };

      const tag = fastify.services.tags.get(handle);
      if (!tag) {
        throw new ApiNotFoundError(`Tag '${handle}' not found`);
      }

      return ok(tag);
    },
  );

  // GET /api/tags/:handle/projects — delegates to project list with tag pre-applied
  fastify.get(
    '/api/tags/:handle/projects',
    {
      schema: {
        tags: ['tags'],
        summary: 'List projects for a tag',
        params: {
          type: 'object',
          properties: {
            handle: { type: 'string' },
          },
          required: ['handle'],
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
      const { handle } = request.params as { handle: string };
      const q = request.query as Record<string, unknown>;

      const tag = fastify.services.tags.get(handle);
      if (!tag) {
        throw new ApiNotFoundError(`Tag '${handle}' not found`);
      }

      const opts = {
        tag: [handle],
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      };

      const result = fastify.services.projects.list(opts);

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

  // GET /api/tags/:handle/people — delegates to people list with tag pre-applied
  fastify.get(
    '/api/tags/:handle/people',
    {
      schema: {
        tags: ['tags'],
        summary: 'List people for a tag',
        params: {
          type: 'object',
          properties: {
            handle: { type: 'string' },
          },
          required: ['handle'],
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
      const { handle } = request.params as { handle: string };
      const q = request.query as Record<string, unknown>;
      const caller = getCallerSession(request);

      const tag = fastify.services.tags.get(handle);
      if (!tag) {
        throw new ApiNotFoundError(`Tag '${handle}' not found`);
      }

      const opts = {
        tag: [handle],
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
}
