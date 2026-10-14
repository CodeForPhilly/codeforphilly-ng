/**
 * Reconcile plugin.
 *
 * Replaces the data-repo reconciliation that used to live in
 * `deploy/docker/entrypoint.sh`. Registered AFTER `storePlugin` (so the
 * repository handle is available) and BEFORE `servicesPlugin` (so the
 * in-memory state is built from the post-reconciliation tree).
 *
 * Behavior:
 *   - When `CFP_DATA_REMOTE` is unset, reconciliation is skipped entirely
 *     (typical for local dev against a sibling working tree with no remote).
 *   - Otherwise: calls `reconcileDataRepo` for the configured branch and
 *     logs the outcome at the appropriate level:
 *       - 'conflict-escaped' → ERROR with the `conflictBranch` field, so
 *         operators see a loud line in production logs.
 *       - 'fetch-failed'     → WARN — non-fatal, the API still boots from
 *         local state.
 *       - everything else    → INFO.
 *   - Any other thrown error (corrupt repo, missing branch, etc.) propagates
 *     and crashes the boot. k8s will restart the pod and the entrypoint will
 *     re-clone if needed.
 *
 * Decorates Fastify with `reconcileDataRepo({ onMoved })`: fetch outside the
 * lock, then reconcile under the repository's write lock — the same mutex
 * `transact` holds (gitsheets `repo.withLock`), so a reconcile can never race
 * a write. When the reconcile moves the branch, the public store is
 * refreshed and `onMoved` runs inside the same lock, so the hot-reload
 * rebuild can't interleave with a write either.
 *
 * Pushes of the working branch go through the push daemon. At boot the
 * daemon isn't registered yet; its startup backlog pushes anything ahead.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import {
  fetchRemoteBranch,
  reconcileDataRepo,
  type ReconcileResult,
} from '../store/reconcile.js';

export interface ReconcileCallOptions {
  /**
   * Runs under the write lock after a reconcile that moved the branch, once
   * the public store has been refreshed to the new HEAD.
   */
  readonly onMoved?: (result: ReconcileResult) => Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Reconcile the data repo against `CFP_DATA_REMOTE` for
     * `CFP_DATA_BRANCH`. Returns the outcome envelope. Throws on
     * unrecoverable filesystem / git errors; soft failures (fetch blip,
     * conflict-escape) return a non-throwing result.
     */
    reconcileDataRepo: (opts?: ReconcileCallOptions) => Promise<ReconcileResult>;
  }
}

async function reconcilePlugin(fastify: FastifyInstance): Promise<void> {
  const repoPath = fastify.config.CFP_DATA_REPO_PATH;
  const configuredBranch = fastify.config.CFP_DATA_BRANCH;
  const remote = fastify.config.CFP_DATA_REMOTE;

  fastify.decorate(
    'reconcileDataRepo',
    async (opts?: ReconcileCallOptions): Promise<ReconcileResult> => {
      const branch = configuredBranch;
      if (!branch) {
        throw new Error('reconcileDataRepo: CFP_DATA_BRANCH is unset');
      }
      const logger = fastify.log;

      // Network outside the lock: writes keep flowing during a slow fetch.
      // The ref moves below are CAS (`update-ref <ref> <new> <old>`).
      if (!(await fetchRemoteBranch({ repoPath, branch, logger }))) {
        const head = (await fastify.publicRepo.resolveRef('HEAD')) ?? '';
        return { outcome: 'fetch-failed', oldCommit: head, newCommit: head };
      }

      return fastify.publicRepo.withLock(async () => {
        const result = await reconcileDataRepo({
          repoPath,
          branch,
          logger,
          skipFetch: true,
          push: (commit) => {
            fastify.pushDaemon?.notifyCommit(commit);
          },
        });
        if (result.newCommit !== result.oldCommit) {
          await fastify.store.public.refresh();
          await opts?.onMoved?.(result);
        }
        return result;
      });
    },
  );

  // Boot-time reconcile: skipped when no remote is configured (dev).
  if (!remote) {
    fastify.log.info(
      'data-repo reconciliation skipped: CFP_DATA_REMOTE unset (dev mode)',
    );
    return;
  }

  if (!configuredBranch) {
    // Without a branch, we don't know what to reconcile against. Treat as
    // a configuration error — entrypoint should set CFP_DATA_BRANCH
    // alongside CFP_DATA_REMOTE.
    throw new Error(
      'data-repo reconciliation: CFP_DATA_REMOTE set but CFP_DATA_BRANCH unset; refusing to guess',
    );
  }

  const result = await fastify.reconcileDataRepo();

  // Outcome-specific logging so operators get an at-a-glance line in prod.
  switch (result.outcome) {
    case 'conflict-escaped':
      // LOUD: the operator MUST investigate the named branch.
      fastify.log.error(
        {
          branch: configuredBranch,
          conflictBranch: result.conflictBranch,
          oldCommit: result.oldCommit,
          newCommit: result.newCommit,
          ahead: result.ahead,
          behind: result.behind,
        },
        'data-repo reconciliation invoked conflict escape hatch',
      );
      break;
    case 'fetch-failed':
      fastify.log.warn(
        { branch: configuredBranch, commit: result.oldCommit },
        'data-repo reconciliation: fetch failed; continuing with local state',
      );
      break;
    case 'in-sync':
    case 'fast-forwarded':
    case 'pushed-ahead':
    case 'rebased':
      fastify.log.info(
        {
          branch: configuredBranch,
          outcome: result.outcome,
          oldCommit: result.oldCommit,
          newCommit: result.newCommit,
          ahead: result.ahead,
          behind: result.behind,
        },
        'data-repo reconciled',
      );
      break;
  }
}

export default fp(reconcilePlugin, {
  name: 'reconcile',
  fastify: '5.x',
  dependencies: ['store'],
});
