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
 * Decorates Fastify with:
 *   - `dataRepoLock` — a single-slot async lock callers use to serialize
 *     non-`store.transact` git operations (boot reconcile, future webhook).
 *   - `reconcileDataRepo({ branch })` — a thin wrapper that acquires the
 *     lock and invokes the state-machine function with the current
 *     environment. Provided so the future hot-reload webhook (#65) has a
 *     single call to make.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { createDataRepoLock, type DataRepoLock } from '../lib/data-repo-lock.js';
import { reconcileDataRepo, type ReconcileResult } from '../store/reconcile.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Acquire the data-repo lock. Returns a release function; release is
     * idempotent. See `lib/data-repo-lock.ts` for the contract.
     */
    dataRepoLock: DataRepoLock;
    /**
     * Reconcile the local working tree against `CFP_DATA_REMOTE` for the
     * given branch under the data-repo lock. Defaults to the configured
     * `CFP_DATA_BRANCH`.
     *
     * Returns the outcome envelope. Throws on unrecoverable filesystem /
     * git errors; soft failures (fetch blip, conflict-escape) return a
     * non-throwing result.
     */
    reconcileDataRepo: (opts?: { branch?: string }) => Promise<ReconcileResult>;
  }
}

async function reconcilePlugin(fastify: FastifyInstance): Promise<void> {
  const lock = createDataRepoLock();
  fastify.decorate('dataRepoLock', lock);

  const repoPath = fastify.config.CFP_DATA_REPO_PATH;
  const configuredBranch = fastify.config.CFP_DATA_BRANCH;
  const remote = fastify.config.CFP_DATA_REMOTE;

  // Expose a Fastify-bound wrapper so the future webhook handler (#65) has
  // a single call to make. Always under the lock.
  fastify.decorate(
    'reconcileDataRepo',
    async (opts?: { branch?: string }): Promise<ReconcileResult> => {
      const branch = opts?.branch ?? configuredBranch;
      if (!branch) {
        throw new Error(
          'reconcileDataRepo: no branch specified and CFP_DATA_BRANCH is unset',
        );
      }
      const release = await lock();
      try {
        return await reconcileDataRepo({
          repoPath,
          branch,
          logger: fastify.log,
        });
      } finally {
        release();
      }
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

  const release = await lock();
  let result: ReconcileResult;
  try {
    result = await reconcileDataRepo({
      repoPath,
      branch: configuredBranch,
      logger: fastify.log,
    });
  } finally {
    release();
  }

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
