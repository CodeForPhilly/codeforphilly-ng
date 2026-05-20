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

interface GitExecResultWithExit extends GitExecResult {
  readonly exitCode: number;
}

interface GitOpts {
  /** Override the child-process env. Used for setting `GIT_AUTHOR_*` on commit-tree calls. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Treat a non-zero exit code as a normal result (return with `exitCode > 0`)
   * instead of throwing. Used for `merge-tree --write-tree`, which signals
   * conflicts via exit 1 rather than via stderr-only.
   */
  readonly allowFailure?: boolean;
}

/**
 * Run a git command in the data repo. `stderr` is captured (not piped) so
 * exit codes propagate cleanly — none of the pipe-eats-exit-code class of
 * bugs that bit the shell entrypoint.
 *
 * Throws if git exits non-zero (unless `opts.allowFailure`). Most call
 * sites in this module trap the throw and translate it into a structured
 * outcome; only unrecoverable errors bubble out of `reconcileDataRepo`.
 */
async function git(
  repoPath: string,
  ...args: readonly string[]
): Promise<GitExecResult> {
  return exec('git', [...args], { cwd: repoPath, maxBuffer: 32 * 1024 * 1024 });
}

async function gitWithOpts(
  repoPath: string,
  opts: GitOpts,
  ...args: readonly string[]
): Promise<GitExecResultWithExit> {
  try {
    const result = await exec('git', [...args], {
      cwd: repoPath,
      maxBuffer: 32 * 1024 * 1024,
      env: opts.env,
    });
    return { ...result, exitCode: 0 };
  } catch (err) {
    if (
      opts.allowFailure &&
      err !== null &&
      typeof err === 'object' &&
      'code' in err
    ) {
      const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
      return {
        stdout: typeof e.stdout === 'string' ? e.stdout : '',
        stderr: typeof e.stderr === 'string' ? e.stderr : '',
        exitCode: typeof e.code === 'number' ? e.code : 1,
      };
    }
    throw err;
  }
}

/**
 * Signal that a `merge-tree --write-tree` step couldn't produce a clean tree.
 * Caught by the diverged-branch handler to route to the escape-hatch path.
 */
class RebaseReplayConflictError extends Error {
  readonly conflictingCommit: string;
  constructor(commit: string, mergeOutput: string) {
    super(`merge-tree conflict replaying ${commit}: ${mergeOutput}`);
    this.name = 'RebaseReplayConflictError';
    this.conflictingCommit = commit;
  }
}

/**
 * Replay local commits on top of a remote tip, bare-style. Mirrors today's
 * `git rebase <remoteRef>` semantics — linear history, original
 * author/message metadata preserved, committer rewritten to the API's
 * pseudonymous identity — but done entirely via plumbing so it works on
 * bare clones with no working tree.
 *
 * For each local commit C (oldest first), runs:
 *   git merge-tree --write-tree --merge-base=C^ <newTip> C
 *     → tree hash, or exit 1 with conflict markers on stderr
 *   git commit-tree <tree> -p <newTip> -m <C.message>
 *     → new commit hash; becomes newTip for the next iteration
 *
 * Throws `RebaseReplayConflictError` on first conflict so the caller can
 * route to the escape hatch (preserve pre-rebase HEAD on conflicts/<UTC>,
 * fast-forward local refs to remote tip).
 */
async function replayLocalOntoRemote(
  repoPath: string,
  localTip: string,
  remoteTip: string,
  mergeBase: string,
): Promise<string> {
  const revList = await git(
    repoPath,
    'rev-list',
    '--reverse',
    `${mergeBase}..${localTip}`,
  );
  const localCommits = revList.stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);

  let newTip = remoteTip;
  for (const commit of localCommits) {
    const parent = (
      await git(repoPath, 'rev-parse', `${commit}^`)
    ).stdout.trim();

    const merge = await gitWithOpts(
      repoPath,
      { allowFailure: true },
      'merge-tree',
      '--write-tree',
      `--merge-base=${parent}`,
      newTip,
      commit,
    );
    if (merge.exitCode !== 0) {
      // merge-tree --write-tree prints the conflicting tree hash + a list of
      // conflicting paths on stdout, with conflict markers (or `info`-style
      // lines) on stderr depending on the conflict type.
      throw new RebaseReplayConflictError(
        commit,
        [merge.stderr, merge.stdout].filter(Boolean).join('\n'),
      );
    }
    // First line of stdout is the merged tree's hash. (Subsequent lines, if
    // any, describe non-conflict messages; we only care about the tree hash.)
    const mergedTreeHash = merge.stdout.split('\n')[0]?.trim() ?? '';
    if (!/^[0-9a-f]{40}$/.test(mergedTreeHash)) {
      throw new Error(
        `merge-tree returned unexpected stdout (no tree hash on first line) while replaying ${commit}: ${merge.stdout.slice(0, 200)}`,
      );
    }

    // Read original commit metadata: author name/email/iso-date + full
    // message (subject + body + trailers). Committer is rewritten to the
    // API's pseudonymous identity — matches today's `git rebase` behavior
    // (rebase preserves author, resets committer to current user).
    const [authorName, authorEmail, authorDate, message] = await Promise.all([
      git(repoPath, 'show', '-s', '--format=%an', commit).then((r) => r.stdout.trimEnd()),
      git(repoPath, 'show', '-s', '--format=%ae', commit).then((r) => r.stdout.trimEnd()),
      git(repoPath, 'show', '-s', '--format=%aI', commit).then((r) => r.stdout.trimEnd()),
      git(repoPath, 'show', '-s', '--format=%B', commit).then((r) => r.stdout.trimEnd()),
    ]);

    const commitTree = await gitWithOpts(
      repoPath,
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_AUTHOR_DATE: authorDate,
          GIT_COMMITTER_NAME: AUTHOR_NAME,
          GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
          // GIT_COMMITTER_DATE: omitted — picks up wall-clock, matches
          // today's `git rebase` (preserves author date, resets committer date).
        },
      },
      'commit-tree',
      mergedTreeHash,
      '-p',
      newTip,
      '-m',
      message,
    );
    newTip = commitTree.stdout.trim();
  }

  return newTip;
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
 * Reconcile the local bare data clone against `<remote>/<branch>`.
 *
 * Idempotent — calling repeatedly with no upstream changes is a no-op
 * (`outcome: 'in-sync'`).
 *
 * Operates entirely via plumbing (`update-ref`, `merge-tree --write-tree`,
 * `commit-tree`) so it works against a bare repo with no working tree —
 * per the invariant in
 * specs/behaviors/storage.md → "The data clone is bare".
 *
 * Concurrency: this function MUST be called under a write mutex if there
 * are any concurrent gitsheets mutations against the same repo. At boot
 * there's no contention; the hot-reload webhook acquires the mutex first.
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

  // Behind: fast-forward by updating the branch ref straight to the remote
  // commit. `update-ref <ref> <new> <old>` is the bare-repo equivalent of
  // `merge --ff-only` and the trailing `<old>` argument makes the operation
  // CAS-safe — a race with another process advancing the ref would fail
  // here rather than silently clobbering.
  if (oldCommit === mergeBase) {
    const behind = Number(
      (await git(repoPath, 'rev-list', '--count', `HEAD..${remoteRef}`)).stdout.trim(),
    );
    logger.info(
      { branch, behind, from: oldCommit, to: remoteCommit },
      'data-repo behind remote — fast-forwarding',
    );
    await git(repoPath, 'update-ref', `refs/heads/${branch}`, remoteCommit, oldCommit);
    return { outcome: 'fast-forwarded', oldCommit, newCommit: remoteCommit, behind };
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

  let newCommit: string;
  try {
    // Bare-friendly rebase: replay local commits on top of the remote tip
    // using `merge-tree --write-tree` + `commit-tree`. Leaves no
    // mid-operation state behind to abort on conflict — the throw is
    // self-contained.
    newCommit = await replayLocalOntoRemote(repoPath, oldCommit, remoteCommit, mergeBase);
    // Move the branch ref to the replayed tip. CAS against oldCommit so a
    // racing in-process transact (impossible at boot under the mutex,
    // possible-in-principle during webhook reconcile) surfaces as an error
    // rather than silently dropping commits.
    await git(repoPath, 'update-ref', `refs/heads/${branch}`, newCommit, oldCommit);
  } catch (err) {
    // Either a merge-tree conflict or some other plumbing failure during the
    // replay — escape hatch.
    logger.error(
      { err: describe(err), branch, ahead, behind, local: oldCommit, remote: remoteCommit },
      'data-repo rebase conflicted — invoking escape hatch',
    );

    // No mid-rebase state to abort: the replay is pure plumbing on the
    // object DB; nothing in `refs/` was advanced. We just need to preserve
    // the pre-reconcile HEAD on a uniquely-named branch and fast-forward
    // local to the remote tip.

    // Preserve the pre-rebase HEAD on a uniquely-named branch so the
    // operator can investigate. `update-ref --create-reflog` keeps the
    // reconciler idempotent even on a same-second second invocation in
    // tests; `update-ref refs/heads/<name> <commit>` (two-arg form) doesn't
    // require the branch to be absent.
    const conflictBranch = conflictBranchName(now());
    try {
      await git(repoPath, 'update-ref', `refs/heads/${conflictBranch}`, oldCommit);
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
    // forensic recovery via the bare repo on the pod's emptyDir.
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

    // Fast-forward the working branch to the remote tip so the pod boots
    // from a known-good state. (Equivalent to today's `git reset --hard`,
    // but bare-friendly.)
    await git(repoPath, 'update-ref', `refs/heads/${branch}`, remoteCommit, oldCommit);
    return {
      outcome: 'conflict-escaped',
      oldCommit,
      newCommit: remoteCommit,
      conflictBranch,
      ahead,
      behind,
    };
  }

  // Rebase succeeded — push.
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
