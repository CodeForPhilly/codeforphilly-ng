/**
 * Push-daemon plugin.
 *
 * Starts gitsheets' async push daemon against `origin` for the public data
 * repo when `CFP_DATA_REMOTE` is set. The daemon pushes new commits as soon
 * as they're notified (via Repository.transact), with exponential backoff
 * retries on transient failures. Non-fast-forward rejections are logged
 * loudly without retry (terminal — operator must reconcile).
 *
 * See specs/behaviors/storage.md#push-sync and GitHub issue #37.
 *
 * Skipped entirely when `CFP_DATA_REMOTE` is unset (typical for local dev
 * where developers iterate against a sibling working tree with no remote).
 *
 * Depends on `store` (which sets up `fastify.publicRepo`).
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { PushDaemon } from 'gitsheets';

declare module 'fastify' {
  interface FastifyInstance {
    pushDaemon: PushDaemon | null;
  }
}

async function pushDaemonPlugin(fastify: FastifyInstance): Promise<void> {
  if (!fastify.config.CFP_DATA_REMOTE) {
    fastify.log.info(
      'push-daemon disabled: CFP_DATA_REMOTE unset (local commits stay local)',
    );
    fastify.decorate('pushDaemon', null);
    return;
  }

  const daemon = await fastify.publicRepo.startPushDaemon({
    remote: 'origin',
    branch: fastify.config.CFP_DATA_BRANCH,
    backoff: 'exponential',
  });

  daemon.on('push', ({ commit, durationMs }: { commit: string; durationMs: number }) => {
    fastify.log.info({ commit, durationMs }, 'pushed commit to origin');
  });
  daemon.on('retry', ({ attempt, nextDelayMs }: { attempt: number; nextDelayMs: number }) => {
    fastify.log.info({ attempt, nextDelayMs }, 'push-daemon retrying');
  });
  daemon.on(
    'error',
    ({
      err,
      attempt,
      reason,
    }: {
      err: unknown;
      attempt: number;
      reason: 'non-fast-forward' | 'unknown';
    }) => {
      if (reason === 'non-fast-forward') {
        fastify.log.error(
          { err: String(err), attempt },
          'push rejected non-fast-forward — manual reconciliation required',
        );
      } else {
        fastify.log.warn({ err: String(err), attempt, reason }, 'push attempt failed');
      }
    },
  );

  fastify.decorate('pushDaemon', daemon);

  fastify.addHook('onClose', async () => {
    fastify.log.info('stopping push-daemon');
    await daemon.stop();
  });

  fastify.log.info(
    { remote: 'origin', branch: fastify.config.CFP_DATA_BRANCH ?? 'HEAD' },
    'push-daemon started',
  );
}

export default fp(pushDaemonPlugin, {
  name: 'push-daemon',
  fastify: '5.x',
  dependencies: ['store'],
});
