/**
 * Event reminder sweep plugin — specs/behaviors/events.md#reminders.
 *
 * Runs the sweep once when the server is ready and then every five minutes,
 * the same shape as the revocation sweeper in auth/middleware.ts. In-process
 * on purpose: the bookkeeping write goes through the store's single writer.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { EventReminderService, SWEEP_INTERVAL_MS } from '../services/event-reminders.js';

declare module 'fastify' {
  interface FastifyInstance {
    eventReminders: EventReminderService;
  }
}

async function eventRemindersPlugin(fastify: FastifyInstance): Promise<void> {
  const service = new EventReminderService({
    state: fastify.inMemoryState,
    fts: fastify.fts,
    store: fastify.store,
    privateStore: fastify.store.private,
    notifier: fastify.notifier,
    siteHost: fastify.config.CFP_SITE_HOST,
    log: fastify.log,
  });
  fastify.decorate('eventReminders', service);

  const run = (): void => {
    void service.sweep().catch((err) => {
      fastify.log.error({ err }, 'event reminder sweep failed');
    });
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  fastify.addHook('onReady', async () => {
    // Tests boot many apps; a timer per app would leak. The sweep is
    // exercised directly there.
    if (fastify.config.NODE_ENV === 'test') return;
    run();
    interval = setInterval(run, SWEEP_INTERVAL_MS);
  });
  fastify.addHook('onClose', async () => {
    if (interval) clearInterval(interval);
  });
}

export default fp(eventRemindersPlugin, {
  name: 'event-reminders',
  fastify: '5.x',
  dependencies: ['services'],
});
