/**
 * Project routes:
 *   GET /api/projects
 *   GET /api/projects/:slug
 */
import type { FastifyInstance } from 'fastify';
import { ok, paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { getCallerSession } from '../lib/session.js';

export async function projectRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/projects
  fastify.get(
    '/api/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'List/browse projects',
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            stage: { type: 'string' },
            stageIn: { type: 'string' },
            tag: { type: 'array', items: { type: 'string' } },
            maintainer: { type: 'string' },
            memberSlug: { type: 'string' },
            helpWanted: { type: 'boolean' },
            featured: { type: 'boolean' },
            includeDeleted: { type: 'boolean' },
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
        q: q['q'] as string | undefined,
        stage: q['stage'] as string | undefined,
        stageIn: q['stageIn'] ? String(q['stageIn']).split(',') : undefined,
        tag: q['tag'] as string[] | undefined,
        maintainer: q['maintainer'] as string | undefined,
        memberSlug: q['memberSlug'] as string | undefined,
        helpWanted: q['helpWanted'] as boolean | undefined,
        featured: q['featured'] as boolean | undefined,
        includeDeleted: q['includeDeleted'] as boolean | undefined,
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      };

      const caller = getCallerSession(request);
      const isStaff =
        caller?.accountLevel === 'staff' || caller?.accountLevel === 'administrator';

      // Non-staff cannot use includeDeleted
      if (opts.includeDeleted && !isStaff) {
        opts.includeDeleted = undefined;
      }

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

  // GET /api/projects/:slug
  fastify.get(
    '/api/projects/:slug',
    {
      schema: {
        tags: ['projects'],
        summary: 'Fetch a single project',
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

      const project = fastify.services.projects.get(slug, caller);
      if (!project) {
        throw new ApiNotFoundError(`Project '${slug}' not found`);
      }

      return ok(project);
    },
  );
}
