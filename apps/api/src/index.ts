/**
 * API entry point.
 *
 * Calls buildApp() to construct the Fastify instance with all plugins and
 * routes registered, then starts listening. All configuration is handled
 * inside buildApp() via @fastify/env — this file reads nothing from process.env
 * directly.
 */
import { buildApp } from './app.js';

const fastify = await buildApp();

const PORT = Number(process.env['PORT'] ?? 3001);
const HOST = process.env['HOST'] ?? '0.0.0.0';

try {
  await fastify.listen({ port: PORT, host: HOST });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
