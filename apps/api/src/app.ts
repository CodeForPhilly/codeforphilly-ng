/**
 * buildApp() — wires the Fastify application.
 *
 * Plugin ordering per plans/api-skeleton.md#plugin-order:
 *  1. @fastify/env         → validates env; populates fastify.config
 *  2. @fastify/cors        → CORS for dev SPA proxy + future cross-origin consumers
 *  3. @fastify/cookie      → cookie parsing for session JWTs (auth-jwt-substrate plan)
 *  4. trace-id plugin      → UUIDv7 traceId on every request
 *  5. setErrorHandler      → single error mapper for all throws
 *  6. store plugin         → decorates fastify.store from bootStores()
 *  7. rate-limit plugin    → in-memory counters keyed per-IP + per-account
 *  8. idempotency plugin   → in-memory map keyed by personId+key
 *  9. @fastify/swagger      → OpenAPI 3.1 doc generation
 * 10. @fastify/swagger-ui   → Swagger UI at /api/_docs
 * 11. routes               → registered last after all plumbing
 *
 * Tests can call buildApp() with overrideEnv to inject a test environment
 * without requiring real filesystem paths.
 */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyEnv from '@fastify/env';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';

import { envJsonSchema, type Env } from './env.js';
import { mapError } from './lib/errors.js';
import traceIdPlugin from './plugins/trace-id.js';
import storePlugin from './plugins/store.js';
import servicesPlugin from './plugins/services.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import idempotencyPlugin from './plugins/idempotency.js';
import sessionMiddlewarePlugin from './auth/middleware.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { peopleRoutes } from './routes/people.js';
import { tagRoutes } from './routes/tags.js';
import { projectUpdateRoutes } from './routes/projects-updates.js';
import { projectBuzzRoutes } from './routes/projects-buzz.js';
import { helpWantedRoutes } from './routes/projects-help-wanted.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Env;
  }
}

export interface BuildAppOptions {
  /**
   * Override environment variables for testing.
   * When provided, @fastify/env still validates the schema but reads from this
   * object instead of process.env.
   */
  overrideEnv?: Partial<Record<string, string>>;
  /** Extra Fastify server options (e.g. logger: false for tests). */
  serverOptions?: FastifyServerOptions;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { overrideEnv, serverOptions = {} } = opts;

  // Default logger: pretty in dev, JSON in prod.
  // Callers can override via serverOptions.logger.
  const defaultLogger: FastifyServerOptions['logger'] =
    process.env['NODE_ENV'] === 'production'
      ? true
      : { transport: { target: 'pino-pretty' } };

  const fastify = Fastify({
    logger: defaultLogger,
    pluginTimeout: 30_000, // gitsheets boot runs git operations which can be slow
    ...serverOptions,
    genReqId: () => '', // traceId plugin handles IDs
  });

  // ----- 1. Env validation -----
  await fastify.register(fastifyEnv, {
    schema: envJsonSchema,
    data: overrideEnv ?? process.env,
    dotenv: false,
  });

  // ----- 2. CORS -----
  await fastify.register(fastifyCors, {
    origin: fastify.config.NODE_ENV === 'production' ? false : true,
    credentials: true,
  });

  // ----- 3. Cookie parsing -----
  await fastify.register(fastifyCookie);

  // ----- 4. Trace ID (UUIDv7 on every request) -----
  await fastify.register(traceIdPlugin);

  // ----- 5. Error mapper -----
  fastify.setErrorHandler(mapError);

  // ----- 6. Store (boots gitsheets + private-store) -----
  await fastify.register(storePlugin);

  // ----- 6b. Services (loads in-memory state + FTS, boots after store) -----
  await fastify.register(servicesPlugin);

  // ----- 7. Rate limiting -----
  await fastify.register(rateLimitPlugin);

  // ----- 8. Idempotency -----
  await fastify.register(idempotencyPlugin);

  // ----- 8a. Session middleware (JWT auth) -----
  await fastify.register(sessionMiddlewarePlugin);

  // ----- 9-10. OpenAPI / Swagger UI -----
  await fastify.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'CodeForPhilly API',
        description: 'The codeforphilly.org API. See specs/api/ for the authoritative spec.',
        version: '1.0.0',
      },
      servers: [{ url: '/api', description: 'API base' }],
      tags: [{ name: 'health', description: 'Health check' }],
    },
    prefix: '/api',
  });

  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/api/_docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
  });

  // ----- 11. Routes -----
  await fastify.register(healthRoutes);
  await fastify.register(authRoutes);
  await fastify.register(projectRoutes);
  await fastify.register(peopleRoutes);
  await fastify.register(tagRoutes);
  await fastify.register(projectUpdateRoutes);
  await fastify.register(projectBuzzRoutes);
  await fastify.register(helpWantedRoutes);

  // Serve the OpenAPI JSON at the spec-mandated path /api/_openapi.json
  // (swagger-ui also exposes it at /api/_docs/json, but the spec names this path)
  fastify.get('/api/_openapi.json', { schema: { hide: true } }, (_req, reply) => {
    return reply.send(fastify.swagger());
  });

  return fastify;
}
