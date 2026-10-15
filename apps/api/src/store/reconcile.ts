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
 * 'pushed-ahead'), strips `refs/heads/` off the conflict branch and keeps
 * the operator-facing log lines. `repo.sync()` hands an ahead/replayed tip
 * to the repository's running push daemon itself; at boot there is none
 * yet, and the daemon's startup backlog pushes it.
 *
 * Unrecoverable errors (unrelated histories, missing branch, corrupt repo)
 * propagate as rejections — the boot plugin lets the API crash and k8s
 * restarts the pod.
 *
 * Locking: `repo.sync()` takes the write lock of the Repository it runs on
 * — the serving one, the mutex every `transact` contends on — for the ref
 * move, and awaits the caller's `afterMove` inside it. The API's store
 * refresh and in-memory rebuild run there, so no write can commit between
 * the ref move and the end of the rebuild. The fetch runs before, outside
 * the lock. See plugins/reconcile.ts.
 */
import type { Repository, SyncResult } from 'gitsheets';

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
  /**
   * The serving Repository on the bare data clone. Sync takes its write
   * lock, so `afterMove` is atomic with respect to its `transact`s.
   */
  readonly repo: Repository;
  /** Branch to reconcile. */
  readonly branch: string;
  /** Remote name to fetch/push against. Default: 'origin'. */
  readonly remote?: string;
  /** Logger; mirrors Fastify's pino interface. */
  readonly logger: ReconcileLogger;
  /** Skip the fetch: the caller already ran {@link fetchRemoteBranch}. */
  readonly skipFetch?: boolean;
  /**
   * Awaited under the repository's write lock after the reconcile moved the
   * branch (gitsheets `sync`'s `afterMove`), before the lock is released:
   * no `transact` can commit in between. It must not `transact` or
   * `withLock` itself (`lock_held`). A throw propagates after the lock is
   * released, with the branch already moved. Not called when nothing moved.
   */
  readonly afterMove?: (result: ReconcileResult) => Promise<void> | void;
  /**
   * Extra hand-off for an ahead or rebased tip, called after the sync.
   * Only for a repository with no running push daemon: `repo.sync()`
   * already notifies a running one, so passing this as well would notify
   * twice. Omitted, nothing beyond sync's own hand-off happens.
   */
  readonly push?: (commit: string) => Promise<void> | void;
}

/**
 * Fetch `<remote>/<branch>` into `refs/remotes/<remote>/<branch>` without
 * taking the write lock (gitsheets `repo.fetch`, which never throws on a
 * network or auth failure). Returns false (after logging) when the fetch
 * fails. Same explicit refspec sync uses, so a single-branch or bare clone
 * still populates the remote-tracking ref.
 */
export async function fetchRemoteBranch(opts: {
  readonly repo: Repository;
  readonly branch: string;
  readonly remote?: string;
  readonly logger: ReconcileLogger;
}): Promise<boolean> {
  const remote = opts.remote ?? 'origin';
  const fetched = await opts.repo.fetch({ remote, branch: opts.branch });
  if (!fetched.ok) {
    opts.logger.warn(
      { err: fetched.error, remote, branch: opts.branch },
      'data-repo fetch failed; continuing with local state',
    );
    return false;
  }
  return true;
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
 * Concurrency: the fetch runs outside any lock; the ref move and
 * `afterMove` run in one critical section of `repo`'s write lock (see the
 * module comment).
 */
export async function reconcileDataRepo(
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const remote = opts.remote ?? 'origin';
  const { repo, branch, logger } = opts;

  if (!opts.skipFetch && !(await fetchRemoteBranch({ repo, branch, remote, logger }))) {
    const current = (await repo.resolveRef(`refs/heads/${branch}`)) ?? '';
    return { outcome: 'fetch-failed', oldCommit: current, newCommit: current };
  }

  const afterMove = opts.afterMove;
  const raw = await repo.sync({
    remote,
    branch,
    fetch: false,
    onConflict: 'preserve-branch',
    conflictBranchPrefix: 'conflicts/',
    pushConflictBranch: true,
    committer: { name: AUTHOR_NAME, email: AUTHOR_EMAIL },
    ...(afterMove ? { afterMove: (moved: SyncResult) => afterMove(toResult(moved)) } : {}),
  });

  const result = toResult(raw);
  const { outcome, oldCommit, newCommit, ahead, behind } = result;

  switch (outcome) {
    case 'fetch-failed':
      // Unreachable with fetch: false; kept for exhaustiveness.
      logger.warn(
        { err: raw.fetchError, remote, branch },
        'data-repo fetch failed; continuing with local state',
      );
      return result;

    case 'in-sync':
      logger.info({ branch, commit: oldCommit }, 'data-repo in sync with remote');
      return result;

    case 'fast-forwarded':
      logger.info(
        { branch, behind, from: oldCommit, to: newCommit },
        'data-repo behind remote — fast-forwarding',
      );
      return result;

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
      return result;

    case 'conflict-escaped': {
      const fields = {
        branch,
        ahead,
        behind,
        conflictBranch: result.conflictBranch,
        preservedCommit: raw.conflictCommit ?? oldCommit,
        remoteCommit: newCommit,
      };
      logger.error(
        fields,
        raw.conflictBranchPushed
          ? 'data-repo replay conflicted — divergent commits preserved on remote; operator must investigate'
          : 'data-repo replay conflicted — divergent commits preserved LOCALLY only (push failed); operator must investigate',
      );
      return result;
    }
  }
}

/** gitsheets' sync result → ours. */
function toResult(raw: SyncResult): ReconcileResult {
  const outcome = mapOutcome(raw.outcome);
  const { oldCommit, newCommit, ahead, behind } = raw;
  if (outcome === 'conflict-escaped') {
    const conflictBranch = (raw.conflictBranch ?? '').replace(/^refs\/heads\//, '');
    return { outcome, oldCommit, newCommit, conflictBranch, ahead, behind };
  }
  return { outcome, oldCommit, newCommit, ahead, behind };
}
