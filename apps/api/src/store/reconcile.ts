/**
 * Data-repo reconciliation — a thin adapter over gitsheets' `repo.sync()`.
 *
 * gitsheets owns the state machine (specs/behaviors/storage.md → Hot reload,
 * Sync to GitHub):
 *
 *   local == remote                         → 'in-sync'
 *   local is ancestor of remote (behind)    → CAS fast-forward → 'fast-forwarded'
 *   remote is ancestor of local (ahead)     → hand off to push → 'pushed-ahead'
 *   diverged, replay clean                  → replay local commits onto the
 *                                             remote tip (author + message
 *                                             kept, committer = API identity),
 *                                             hand off to push → 'rebased'
 *   diverged, replay conflicts              → preserve the local tip on
 *                                             conflicts/<UTC>, push that branch
 *                                             best-effort, adopt the remote →
 *                                             'conflict-escaped'
 *   fetch itself fails (network blip)       → 'fetch-failed', no changes
 *
 * This module maps gitsheets' outcome vocabulary onto ours ('ahead' →
 * 'pushed-ahead'), strips `refs/heads/` off the conflict branch, routes the
 * push of an ahead/replayed tip through the caller's `push` hand-off, and
 * keeps the operator-facing log lines.
 *
 * Unrecoverable errors (unrelated histories, missing branch, corrupt repo)
 * propagate as rejections — the boot plugin lets the API crash and k8s
 * restarts the pod.
 *
 * Locking: `repo.sync()` takes the write lock of the Repository it is called
 * on, and refuses (`lock_held`) to run inside that repository's `withLock`.
 * The API needs the ref move, store refresh and in-memory rebuild in ONE
 * critical section of the *serving* repository's lock, so this function
 * syncs through its own short-lived Repository handle on the same gitdir:
 * the caller holds the serving handle's lock — the one every write contends
 * on — for the whole reconcile, and the side handle's own lock is
 * uncontended. The side handle has no live sheets and no push daemon, which
 * is why the caller refreshes its store and `push` hands the tip to the
 * serving daemon. See plugins/reconcile.ts.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { openRepo, type SyncResult } from 'gitsheets';

const exec = promisify(execFile);

export const AUTHOR_NAME = 'Code for Philly API';
export const AUTHOR_EMAIL = 'api@users.noreply.codeforphilly.org';

export type ReconcileOutcome =
  | 'in-sync'
  | 'fast-forwarded'
  | 'pushed-ahead'
  | 'rebased'
  | 'conflict-escaped'
  | 'fetch-failed';

export interface ReconcileResult {
  readonly outcome: ReconcileOutcome;
  readonly oldCommit: string;
  readonly newCommit: string;
  /** Present only when `outcome === 'conflict-escaped'`, e.g. `conflicts/2026-08-15T12-34-56Z`. */
  readonly conflictBranch?: string;
  /** Counts ahead/behind relative to the remote pre-reconciliation, when known. */
  readonly ahead?: number;
  readonly behind?: number;
}

/**
 * Minimal logger contract — anything Fastify's pino logger (or a console
 * shim in tests) can satisfy. Three levels are enough for this module.
 */
export interface ReconcileLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ReconcileOptions {
  /** Absolute path to the bare data clone. */
  readonly repoPath: string;
  /** Branch to reconcile. */
  readonly branch: string;
  /** Remote name to fetch/push against. Default: 'origin'. */
  readonly remote?: string;
  /** Logger; mirrors Fastify's pino interface. */
  readonly logger: ReconcileLogger;
  /**
   * Skip the fetch: the caller already ran {@link fetchRemoteBranch} (the
   * API does, outside the repository write lock, so a slow network never
   * blocks writes).
   */
  readonly skipFetch?: boolean;
  /**
   * Publish `branch` after an ahead or rebased outcome. The API hands the
   * commit to the gitsheets push daemon so every push of the working branch
   * goes through one place; at boot (no daemon yet) the daemon's startup
   * backlog pushes it. Omitted, nothing is pushed.
   */
  readonly push?: (commit: string) => Promise<void> | void;
}

/**
 * Fetch `<remote>/<branch>` into `refs/remotes/<remote>/<branch>` without
 * touching any lock. Returns false (after logging) when the fetch fails.
 *
 * `repo.sync()` can fetch, but takes the write lock in the same call, and
 * the API must hold the lock across sync *and* rebuild — so it fetches here
 * first, outside any lock, then syncs with `skipFetch`. Same explicit
 * refspec sync uses, so a single-branch or bare clone still populates the
 * remote-tracking ref.
 */
export async function fetchRemoteBranch(opts: {
  readonly repoPath: string;
  readonly branch: string;
  readonly remote?: string;
  readonly logger: ReconcileLogger;
}): Promise<boolean> {
  const remote = opts.remote ?? 'origin';
  const refspec = `+refs/heads/${opts.branch}:refs/remotes/${remote}/${opts.branch}`;
  try {
    await exec('git', ['fetch', '--prune', remote, refspec], { cwd: opts.repoPath });
    return true;
  } catch (err) {
    opts.logger.warn(
      { err: describe(err), remote, branch: opts.branch },
      'data-repo fetch failed; continuing with local state',
    );
    return false;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** gitsheets' outcome vocabulary → ours. */
function mapOutcome(outcome: SyncResult['outcome']): ReconcileOutcome {
  switch (outcome) {
    case 'ahead':
      return 'pushed-ahead';
    case 'conflict':
      // Only reachable with onConflict: 'fail', which we never pass.
      throw new Error("repo.sync returned 'conflict' despite onConflict: 'preserve-branch'");
    default:
      return outcome;
  }
}

/**
 * Reconcile the local bare data clone against `<remote>/<branch>`.
 *
 * Idempotent — calling repeatedly with no upstream changes is a no-op
 * (`outcome: 'in-sync'`).
 *
 * Concurrency: the API calls this while holding the serving Repository's
 * write lock (see the module comment). At boot there's no contention.
 */
export async function reconcileDataRepo(
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const remote = opts.remote ?? 'origin';
  const { repoPath, branch, logger } = opts;

  // A side handle — see the module comment on locking.
  const repo = await openRepo({ gitDir: repoPath });
  const raw = await repo.sync({
    remote,
    branch,
    fetch: !opts.skipFetch,
    onConflict: 'preserve-branch',
    conflictBranchPrefix: 'conflicts/',
    pushConflictBranch: true,
    committer: { name: AUTHOR_NAME, email: AUTHOR_EMAIL },
  });

  const outcome = mapOutcome(raw.outcome);
  const { oldCommit, newCommit, ahead, behind } = raw;

  switch (outcome) {
    case 'fetch-failed':
      logger.warn(
        { err: raw.fetchError, remote, branch },
        'data-repo fetch failed; continuing with local state',
      );
      return { outcome, oldCommit, newCommit };

    case 'in-sync':
      logger.info({ branch, commit: oldCommit }, 'data-repo in sync with remote');
      return { outcome, oldCommit, newCommit, ahead, behind };

    case 'fast-forwarded':
      logger.info(
        { branch, behind, from: oldCommit, to: newCommit },
        'data-repo behind remote — fast-forwarding',
      );
      return { outcome, oldCommit, newCommit, ahead, behind };

    case 'pushed-ahead':
    case 'rebased':
      logger.info(
        { branch, outcome, ahead, behind, from: oldCommit, to: newCommit },
        outcome === 'rebased'
          ? 'data-repo diverged from remote — replayed local commits cleanly'
          : 'data-repo ahead of remote',
      );
      if (opts.push) {
        try {
          await opts.push(newCommit);
          logger.info({ branch, commit: newCommit }, 'data-repo push handed off');
        } catch (err) {
          // Non-fatal: the push daemon retries with backoff.
          logger.warn(
            { err: describe(err), branch },
            'data-repo push hand-off failed during reconcile; push-daemon will retry',
          );
        }
      }
      return { outcome, oldCommit, newCommit, ahead, behind };

    case 'conflict-escaped': {
      const conflictBranch = (raw.conflictBranch ?? '').replace(/^refs\/heads\//, '');
      const fields = {
        branch,
        ahead,
        behind,
        conflictBranch,
        preservedCommit: raw.conflictCommit ?? oldCommit,
        remoteCommit: newCommit,
      };
      logger.error(
        fields,
        raw.conflictBranchPushed
          ? 'data-repo replay conflicted — divergent commits preserved on remote; operator must investigate'
          : 'data-repo replay conflicted — divergent commits preserved LOCALLY only (push failed); operator must investigate',
      );
      return { outcome, oldCommit, newCommit, conflictBranch, ahead, behind };
    }
  }
}
