/**
 * Scheduled spam purge plugin — specs/behaviors/person-lifecycle.md →
 * "Scheduled spam purge". Runs once when the server is ready and then daily;
 * in-process because the purge writes through the store's single writer.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { SPAM_PURGE_INTERVAL_MS, SpamPurgeService } from '../services/spam-purge.js';

/**
 * Whether this pod runs the sweep: only when CFP_SCHEDULED_PURGE is "true",
 * and never under tests (they call the sweep directly).
 */
export function scheduledPurgeEnabled(config: { NODE_ENV: string; CFP_SCHEDULED_PURGE: string }): boolean {
  return config.NODE_ENV !== 'test' && config.CFP_SCHEDULED_PURGE === 'true';
}

declare module 'fastify' {
  interface FastifyInstance {
    spamPurge: SpamPurgeService;
  }
}

async function spamPurgePlugin(fastify: FastifyInstance): Promise<void> {
  const service = new SpamPurgeService({
    state: fastify.inMemoryState,
    fts: fastify.fts,
    store: fastify.store,
    log: fastify.log,
    sessionMetadata: fastify.sessionMetadata,
  });
  fastify.decorate('spamPurge', service);

  const run = (): void => {
    void service.sweep().catch((err) => {
      fastify.log.error({ err }, 'scheduled spam purge failed');
    });
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  fastify.addHook('onReady', async () => {
    if (!scheduledPurgeEnabled(fastify.config)) {
      fastify.log.info('scheduled spam purge disabled (CFP_SCHEDULED_PURGE is not "true")');
      return;
    }
    run();
    interval = setInterval(run, SPAM_PURGE_INTERVAL_MS);
  });
  fastify.addHook('onClose', async () => {
    if (interval) clearInterval(interval);
  });
}

export default fp(spamPurgePlugin, {
  name: 'spam-purge',
  fastify: '5.x',
  dependencies: ['services', 'session-middleware'],
});
