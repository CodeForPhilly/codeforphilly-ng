/**
 * Event series routes — specs/api/events.md#event-series.
 *
 *   GET    /api/event-series
 *   GET    /api/event-series/:slug
 *   POST   /api/event-series           (staff)
 *   PATCH  /api/event-series/:slug     (staff)
 *   DELETE /api/event-series/:slug     (staff)
 */
import type { FastifyInstance } from 'fastify';

import { ApiNotFoundError } from '../lib/errors.js';
import { ok, paginated } from '../lib/response.js';
import type { EventSeriesInput } from '../services/event-series.js';
import { getCallerSession } from '../services/permissions.js';
import { buildTransactionOptions } from '../store/commit-meta.js';

const slugParams = {
  type: 'object',
  properties: { slug: { type: 'string' } },
  required: ['slug'],
} as const;

const bodyProperties = {
  title: { type: 'string' },
  slug: { type: ['string', 'null'] },
  description: { type: ['string', 'null'] },
} as const;

export async function eventSeriesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/event-series',
    {
      schema: {
        tags: ['events'],
        summary: 'List event series',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const q = request.query as { page?: number; perPage?: number };
      const result = fastify.services.eventSeries.list(q, getCallerSession(request));
      const page = Math.max(1, q.page ?? 1);
      const perPage = Math.min(100, Math.max(1, q.perPage ?? 50));
      return paginated(result.items, {
        page,
        perPage,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / perPage),
      });
    },
  );

  fastify.get(
    '/api/event-series/:slug',
    { schema: { tags: ['events'], summary: 'Event series detail with its events', params: slugParams } },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const result = fastify.services.eventSeries.get(slug, getCallerSession(request));
      if (!result) throw new ApiNotFoundError(`Event series '${slug}' not found`);
      return ok(result);
    },
  );

  fastify.post(
    '/api/event-series',
    {
      schema: {
        tags: ['events'],
        summary: 'Create an event series (staff)',
        body: { type: 'object', properties: bodyProperties, required: ['title'] },
      },
    },
    async (request, reply) => {
      const body = request.body as EventSeriesInput;
      const result = await fastify.store.transact(
        buildTransactionOptions({ request, action: 'event-series.create', subjectType: 'event-series', responseCode: 201 }),
        async (tx) => fastify.services.eventSeriesWrite.create(tx, body, request.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      reply.code(201);
      return ok(fastify.services.eventSeries.get(result.value.series.slug, getCallerSession(request)));
    },
  );

  fastify.patch(
    '/api/event-series/:slug',
    {
      schema: {
        tags: ['events'],
        summary: 'Edit an event series (staff)',
        params: slugParams,
        body: { type: 'object', properties: bodyProperties },
      },
    },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const body = (request.body ?? {}) as EventSeriesInput;
      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          action: 'event-series.edit',
          subjectType: 'event-series',
          subjectSlug: slug,
          responseCode: 200,
        }),
        async (tx) => fastify.services.eventSeriesWrite.update(tx, slug, body, request.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      return ok(fastify.services.eventSeries.get(result.value.series.slug, getCallerSession(request)));
    },
  );

  fastify.delete(
    '/api/event-series/:slug',
    { schema: { tags: ['events'], summary: 'Delete an empty event series (staff)', params: slugParams } },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          action: 'event-series.delete',
          subjectType: 'event-series',
          subjectSlug: slug,
          responseCode: 204,
        }),
        async (tx) => fastify.services.eventSeriesWrite.delete(tx, slug, request.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      return reply.code(204).send();
    },
  );
}
