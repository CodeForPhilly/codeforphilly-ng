/**
 * Trace-ID plugin.
 *
 * Generates a UUIDv7 traceId for every incoming request and decorates
 * request.traceId with it. Every log line from pino includes the traceId
 * via the logger's mixin config in app.ts.
 *
 * Per specs/api/conventions.md#logging-and-trace-ids.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { uuidv7 } from 'uuidv7';

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
  }
}

async function traceIdPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.decorateRequest('traceId', '');

  fastify.addHook('onRequest', (request, _reply, done) => {
    request.traceId = uuidv7();
    done();
  });
}

export default fp(traceIdPlugin, {
  name: 'trace-id',
  fastify: '5.x',
});
