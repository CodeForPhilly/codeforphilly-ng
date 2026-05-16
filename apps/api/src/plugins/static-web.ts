/**
 * Static-web plugin.
 *
 * Serves the built Vite SPA from `apps/web/dist` as a fallthrough for any
 * request not handled by /api/*. Enabled only when CFP_WEB_DIST_PATH is set
 * (which it is in the production Docker image; not in dev where Vite owns 5173).
 *
 * Per specs/architecture.md: "A single Docker image bundles the built API and
 * serves the static apps/web/dist from the same Fastify instance via
 * @fastify/static. One container, one ingress."
 *
 * SPA fallback: any GET that 404s outside of /api/* is rewritten to /index.html
 * so React Router v7 routes resolve client-side.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function jsonNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).type('application/json').send({
    success: false,
    error: { code: 'not_found', message: 'Not found' },
  });
}

async function staticWebPlugin(fastify: FastifyInstance): Promise<void> {
  const distPath = fastify.config.CFP_WEB_DIST_PATH;

  if (!distPath) {
    // No SPA bundled (dev mode, tests). The 404 envelope still applies — the
    // API contract is the same whether or not the SPA is co-located.
    fastify.log.info('static-web: CFP_WEB_DIST_PATH unset — SPA fallthrough disabled');
    fastify.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => jsonNotFound(reply));
    return;
  }

  const root = resolve(distPath);
  if (!existsSync(root)) {
    // Fail loud — production images bundle the SPA; missing files means a
    // bad build, not a soft-skippable condition.
    throw new Error(`static-web: CFP_WEB_DIST_PATH ${root} does not exist`);
  }

  await fastify.register(fastifyStatic, {
    root,
    prefix: '/',
    wildcard: false,
    // Long cache for hashed assets in /assets/. The notFoundHandler below
    // serves index.html with its own no-cache headers so SPA upgrades land
    // promptly without re-cloning the bundle.
    cacheControl: true,
    maxAge: '1y',
    immutable: true,
  });

  // Read index.html once at boot — it's small and avoids per-request disk IO.
  // fastify-static's own cache-control headers would otherwise stamp the SPA
  // entry point with immutable max-age=1y, which is the wrong policy for the
  // file that decides which assets the browser loads next.
  const indexHtml = await readFile(join(root, 'index.html'), 'utf8');

  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    // API endpoints under /api/* should preserve the 404 envelope, not serve HTML.
    if (request.url.startsWith('/api/')) {
      return jsonNotFound(reply);
    }
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(indexHtml);
  });
}

export default fp(staticWebPlugin, {
  name: 'static-web',
  fastify: '5.x',
  dependencies: ['@fastify/env'],
});
