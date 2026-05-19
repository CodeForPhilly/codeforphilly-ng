/**
 * Data-repo reconciliation state machine.
 *
 * Replaces the shell-side reconciliation that used to live in
 * `deploy/docker/entrypoint.sh`. The same state machine, expressed in
 * structured Node so:
 *
 *   1. It's callable from any boot path or future webhook handler (#65),
 *      not just from a shell process before exec(node).
 *   2. Exit codes propagate naturally as Promise rejections — no more
 *      `git rebase 2>&1 | sed 's/^/  /'` swallowing the rebase exit code.
 *   3. Fetch refspecs are explicit, so a single-branch `git clone --branch X`
 *      can still reconcile a different `Y` later (the original shell version
 *      relied on the implicit remote refspec written by `git clone` and broke
 *      when the operator changed `CFP_DATA_BRANCH`).
 *
 * State machine (same as the entrypoint's):
 *
 *   local == remote                         → 'in-sync'
 *   local is ancestor of remote (behind)    → ff-only merge → 'fast-forwarded'
 *   remote is ancestor of local (ahead)     → push → 'pushed-ahead'
 *                                             (push failure is non-fatal —
 *                                              the push daemon retries)
 *   diverged, rebase clean                  → rebase + push → 'rebased'
 *   diverged, rebase conflicts              → abort rebase, create + push
 *                                             conflicts/<UTC> branch from
 *                                             pre-rebase HEAD, hard-reset
 *                                             local to origin →
 *                                             'conflict-escaped'
 *   fetch itself fails (network blip)       → 'fetch-failed', no changes
 *
 * Unrecoverable errors (missing branch, corrupt repo, etc.) propagate as
 * thrown rejections — the caller (boot plugin) lets the API crash and k8s
 * restarts the pod.
 *
 * Authorship: any commit this function authors (the merge commit for an
 * ff-only merge can't happen; rebase replays existing authors; conflict
 * branch is just a ref) uses the pseudonymous "Code for Philly API"
 * identity, matching the convention used by entrypoint.sh and importer.ts.
 * The function `git config`s user.name / user.email at the top so any
 * implicit committer (rebase rewrite) gets the right value.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  /** Present only when `outcome === 'conflict-escaped'`. */
  readonly conflictBranch?: string;
  /** Counts ahead/behind relative to origin pre-reconciliation, when known. */
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
  /** Absolute path to the local working tree. */
  readonly repoPath: string;
  /** Branch to reconcile (must already be checked out by the caller / entrypoint). */
  readonly branch: string;
  /** Remote name to fetch/push against. Default: 'origin'. */
  readonly remote?: string;
  /** Logger; mirrors Fastify's pino interface. */
  readonly logger: ReconcileLogger;
  /** Override the wall clock — used for conflict-branch naming in tests. */
  readonly now?: () => Date;
}

interface GitExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a git command in the data repo. `stderr` is captured (not piped) so
 * exit codes propagate cleanly — none of the pipe-eats-exit-code class of
 * bugs that bit the shell entrypoint.
 *
 * Throws if git exits non-zero. Most call sites in this module trap the
 * throw and translate it into a structured outcome; only unrecoverable
 * errors bubble out of `reconcileDataRepo`.
 */
async function git(
  repoPath: string,
  ...args: readonly string[]
): Promise<GitExecResult> {
  return exec('git', [...args], { cwd: repoPath, maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Cast an `unknown` error to something describable. Mirrors importer.ts's
 * `describe()` — keeping the shape consistent across the codebase.
 */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Build the `conflicts/<UTC-timestamp>` branch name. Mirrors the
 * entrypoint's `date -u +%Y-%m-%dT%H-%M-%SZ` format so existing operator
 * tooling (alerting on `conflicts/*` ref creation, etc.) keeps working.
 */
function conflictBranchName(now: Date): string {
  // date -u +%Y-%m-%dT%H-%M-%SZ — same shape as the shell version.
  const iso = now.toISOString(); // 2026-05-19T14:23:45.123Z
  // Strip the milliseconds and replace ':' with '-' (git ref-safe).
  const truncated = iso.replace(/\.\d{3}Z$/, 'Z');
  return `conflicts/${truncated.replace(/:/g, '-')}`;
}

/**
 * Reconcile the local working tree against `<remote>/<branch>`.
 *
 * Idempotent — calling repeatedly with no upstream changes is a no-op
 * (`outcome: 'in-sync'`).
 *
 * Assumes the caller has already checked out `branch` in the working tree.
 * (The entrypoint's surviving responsibility is the initial clone; the API's
 * is the reconciliation.)
 *
 * Concurrency: this function MUST be called under a write mutex if there
 * are any concurrent gitsheets mutations against the same repo. At boot
 * there's no contention; the future webhook (#65) acquires the mutex first.
 */
export async function reconcileDataRepo(
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const remote = opts.remote ?? 'origin';
  const { repoPath, branch, logger } = opts;
  const now = opts.now ?? ((): Date => new Date());

  // Set a deterministic committer identity for any rewrite (rebase replays
  // can mint new committer lines even though authors are preserved).
  await git(repoPath, 'config', 'user.name', AUTHOR_NAME);
  await git(repoPath, 'config', 'user.email', AUTHOR_EMAIL);

  // Capture pre-reconciliation HEAD for the result envelope (and for the
  // conflict-escape-hatch which needs to preserve the pre-rebase ref).
  const oldCommit = (await git(repoPath, 'rev-parse', 'HEAD')).stdout.trim();

  // ---- Fetch ----
  // Explicit refspec — never trust the remote's implicit refspec, which a
  // single-branch `git clone --branch X` writes narrowly and breaks later
  // `git fetch origin Y`. This is the first of the two latent shell bugs
  // obsoleted by moving into Node.
  const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  try {
    await git(repoPath, 'fetch', '--prune', remote, refspec);
  } catch (err) {
    logger.warn(
      { err: describe(err), remote, branch },
      'data-repo fetch failed; continuing with local state',
    );
    return { outcome: 'fetch-failed', oldCommit, newCommit: oldCommit };
  }

  // ---- Compare HEAD vs <remote>/<branch> ----
  const remoteRef = `${remote}/${branch}`;
  const remoteCommit = (await git(repoPath, 'rev-parse', remoteRef)).stdout.trim();

  if (oldCommit === remoteCommit) {
    logger.info({ branch, commit: oldCommit }, 'data-repo in sync with remote');
    return { outcome: 'in-sync', oldCommit, newCommit: oldCommit };
  }

  // merge-base will throw if there's no common ancestor; bubble out as a
  // boot-fatal — that means the local branch and the remote share no
  // history, which is "operator did something weird, fix it" territory.
  const mergeBase = (
    await git(repoPath, 'merge-base', 'HEAD', remoteRef)
  ).stdout.trim();

  // Behind: fast-forward.
  if (oldCommit === mergeBase) {
    const behind = Number(
      (await git(repoPath, 'rev-list', '--count', `HEAD..${remoteRef}`)).stdout.trim(),
    );
    logger.info(
      { branch, behind, from: oldCommit, to: remoteCommit },
      'data-repo behind remote — fast-forwarding',
    );
    await git(repoPath, 'merge', '--ff-only', remoteRef);
    const newCommit = (await git(repoPath, 'rev-parse', 'HEAD')).stdout.trim();
    return { outcome: 'fast-forwarded', oldCommit, newCommit, behind };
  }

  // Ahead: push.
  if (remoteCommit === mergeBase) {
    const ahead = Number(
      (await git(repoPath, 'rev-list', '--count', `${remoteRef}..HEAD`)).stdout.trim(),
    );
    logger.info(
      { branch, ahead, from: remoteCommit, to: oldCommit },
      'data-repo ahead of remote — pushing',
    );
    try {
      await git(repoPath, 'push', remote, branch);
      logger.info({ branch, commit: oldCommit }, 'data-repo push succeeded');
    } catch (err) {
      // Non-fatal: the push daemon retries with backoff. Worst case
      // operator intervention happens after the API is up.
      logger.warn(
        { err: describe(err), branch },
        'data-repo push failed during reconcile; push-daemon will retry',
      );
    }
    return { outcome: 'pushed-ahead', oldCommit, newCommit: oldCommit, ahead };
  }

  // Diverged.
  const ahead = Number(
    (await git(repoPath, 'rev-list', '--count', `${remoteRef}..HEAD`)).stdout.trim(),
  );
  const behind = Number(
    (await git(repoPath, 'rev-list', '--count', `HEAD..${remoteRef}`)).stdout.trim(),
  );
  logger.info(
    { branch, ahead, behind, local: oldCommit, remote: remoteCommit },
    'data-repo diverged from remote — attempting rebase',
  );

  try {
    await git(repoPath, 'rebase', remoteRef);
  } catch (err) {
    // Rebase failed — escape hatch.
    logger.error(
      { err: describe(err), branch, ahead, behind, local: oldCommit, remote: remoteCommit },
      'data-repo rebase conflicted — invoking escape hatch',
    );

    // Abort the in-progress rebase. If `git rebase --abort` itself fails,
    // we still want to forge ahead to the conflict-branch preservation —
    // log + continue.
    try {
      await git(repoPath, 'rebase', '--abort');
    } catch (abortErr) {
      logger.warn(
        { err: describe(abortErr), branch },
        'rebase --abort itself failed; continuing escape-hatch',
      );
    }

    // Preserve the pre-rebase HEAD on a uniquely-named branch so the
    // operator can investigate. `branch --force` lets the reconciler stay
    // idempotent even on the same-second second invocation in tests.
    const conflictBranch = conflictBranchName(now());
    try {
      await git(repoPath, 'branch', '--force', conflictBranch, oldCommit);
    } catch (branchErr) {
      // If we can't even create a ref locally, that's an unrecoverable
      // filesystem-level problem.
      throw new Error(
        `data-repo escape hatch: failed to create ${conflictBranch} from ${oldCommit}: ${describe(branchErr)}`,
        { cause: branchErr },
      );
    }

    // Push the conflict branch to origin so the operator can see it from
    // GitHub. Non-fatal if push fails — the local ref is still there for
    // forensic recovery via the PVC.
    try {
      await git(repoPath, 'push', remote, conflictBranch);
      logger.error(
        { branch, conflictBranch, preservedCommit: oldCommit },
        'data-repo divergent commits preserved on remote — operator must investigate',
      );
    } catch (pushErr) {
      logger.error(
        {
          err: describe(pushErr),
          branch,
          conflictBranch,
          preservedCommit: oldCommit,
        },
        'data-repo divergent commits preserved LOCALLY only (push failed) — operator must investigate',
      );
    }

    // Hard-reset to origin so the pod boots from a known-good state.
    await git(repoPath, 'reset', '--hard', remoteRef);
    const newCommit = (await git(repoPath, 'rev-parse', 'HEAD')).stdout.trim();
    return {
      outcome: 'conflict-escaped',
      oldCommit,
      newCommit,
      conflictBranch,
      ahead,
      behind,
    };
  }

  // Rebase succeeded — push.
  const newCommit = (await git(repoPath, 'rev-parse', 'HEAD')).stdout.trim();
  logger.info(
    { branch, ahead, behind, from: oldCommit, to: newCommit },
    'data-repo rebase clean — pushing',
  );
  try {
    await git(repoPath, 'push', remote, branch);
    logger.info({ branch, commit: newCommit }, 'data-repo push succeeded after rebase');
  } catch (err) {
    logger.warn(
      { err: describe(err), branch },
      'data-repo push after rebase failed; push-daemon will retry',
    );
  }
  return { outcome: 'rebased', oldCommit, newCommit, ahead, behind };
}
