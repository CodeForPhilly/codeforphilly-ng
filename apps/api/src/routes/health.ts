/**
 * Health check endpoint.
 *
 * GET /api/health → { success: true, data: { status: 'ok' }, metadata: { timestamp } }
 *
 * Returns 200 if the server is up. No auth required. No rate limiting applied
 * (but the global rate-limit hook still runs; this counts toward the IP cap).
 */
import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/response.js';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Health check',
        description: 'Returns ok when the server is running.',
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  status: { type: 'string' },
                },
              },
              metadata: {
                type: 'object',
                properties: {
                  timestamp: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    () => {
      return ok({ status: 'ok' });
    },
  );

  // Readiness probe: 200 only after both stores have loaded and services are
  // wired. Used by k8s readinessProbe; never routes traffic to a pod whose
  // in-memory state is still warming.
  fastify.get(
    '/api/health/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness check',
        description: 'Returns 200 only when both stores have loaded and services are wired.',
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  status: { type: 'string' },
                  publicStore: { type: 'boolean' },
                  privateStore: { type: 'boolean' },
                  fts: { type: 'boolean' },
                },
              },
              metadata: {
                type: 'object',
                properties: {
                  timestamp: { type: 'string' },
                },
              },
            },
          },
          503: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    (_req, reply) => {
      const publicStoreReady = Boolean(fastify.store?.public);
      const privateStoreReady = Boolean(fastify.store?.private);
      const ftsReady = Boolean(fastify.fts);

      if (!publicStoreReady || !privateStoreReady || !ftsReady) {
        return reply.code(503).send({
          success: false,
          error: {
            code: 'not_ready',
            message: 'Stores still warming',
          },
        });
      }

      return reply.send(
        ok({
          status: 'ready',
          publicStore: publicStoreReady,
          privateStore: privateStoreReady,
          fts: ftsReady,
        }),
      );
    },
  );

  // Stub route for testing validation errors
  fastify.post(
    '/api/_test/validation-error',
    {
      schema: {
        hide: true,
        body: {
          type: 'object',
          properties: {
            trigger: { type: 'string' },
          },
        },
      },
    },
    async () => {
      const { ApiValidationError } = await import('../lib/errors.js');
      throw new ApiValidationError('Test validation failed', { field: 'required' });
    },
  );

  // Stub route for testing unknown/500 errors
  fastify.post(
    '/api/_test/internal-error',
    { schema: { hide: true } },
    async () => {
      throw new Error('Deliberate internal error — should not leak to client');
    },
  );

  // Stub route for testing idempotency
  fastify.post(
    '/api/_test/idempotency',
    { schema: { hide: true } },
    async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
        const personId = 'test-person';
        const cached = request.server.idempotency.check(personId, idempotencyKey);
        if (cached) {
          return reply.code(cached.status).send(cached.body);
        }

        const body = ok({ echoed: idempotencyKey, at: new Date().toISOString() });
        request.server.idempotency.store(personId, idempotencyKey, { status: 200, body });
        return reply.code(200).send(body);
      }
      return ok({ echoed: null });
    },
  );
}
