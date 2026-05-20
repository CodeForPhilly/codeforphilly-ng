/**
 * Tests for apps/api/src/store/reconcile.ts — the data-repo reconciliation
 * state machine that replaces the shell logic in deploy/docker/entrypoint.sh.
 *
 * Each case sets up an isolated bare "remote" git repo + a local clone, mutates
 * one or both sides to provoke a specific state, then asserts the
 * `reconcileDataRepo` outcome and the resulting tree.
 *
 * Cases covered:
 *  - in-sync                  (no-op)
 *  - fast-forwarded           (local behind, remote has new commits)
 *  - pushed-ahead             (local ahead, push succeeds)
 *  - rebased                  (diverged, clean rebase, push)
 *  - conflict-escaped         (diverged, rebase aborts, conflict branch pushed)
 *  - fetch-failed             (network blip simulated by a bogus remote URL)
 *  - single-branch reconcile  (regression for the latent shell bug —
 *                              `git clone --branch X` + reconcile against the
 *                              same X still works because we always pass
 *                              an explicit refspec)
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconcileDataRepo, type ReconcileLogger } from '../src/store/reconcile.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

/** Captured log lines for assertions. */
interface Captured {
  level: 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

function makeLogger(): { logger: ReconcileLogger; lines: Captured[] } {
  const lines: Captured[] = [];
  const logger: ReconcileLogger = {
    info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => lines.push({ level: 'error', obj, msg }),
  };
  return { logger, lines };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/**
 * Initialize a **bare** local clone at a tmpdir + a corresponding bare
 * "remote" repo. Both repos are bare to match the production invariant
 * documented in specs/behaviors/storage.md — gitsheets / the reconciler
 * operate via plumbing on the object DB only, never via a working tree.
 *
 * Test helpers that need to mint commits do so through a transient
 * working-tree clone (see `commitToBare` / `advanceRemote`), then push
 * back to whichever bare they're targeting.
 *
 * Both initial commits live on `main`.
 */
interface TestRig {
  readonly bare: string;
  readonly local: string;
  readonly cleanup: () => Promise<void>;
}

async function createRig(): Promise<TestRig> {
  const root = await mkdtemp(join(tmpdir(), 'cfp-reconcile-'));
  const bare = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const local = join(root, 'local.git');

  // Seed repo: produces the initial commit on `main`.
  await exec('git', ['init', '-b', 'main', seed]);
  await git(seed, 'config', 'user.email', 'seed@test.local');
  await git(seed, 'config', 'user.name', 'seed');
  await git(seed, 'config', 'commit.gpgsign', 'false');
  await git(seed, 'config', 'core.hooksPath', '/dev/null');
  await writeFile(join(seed, 'README'), 'initial\n');
  await git(seed, 'add', 'README');
  await git(seed, 'commit', '-m', 'initial');

  // Bare remote.
  await exec('git', ['init', '--bare', '-b', 'main', bare]);
  // Allow non-fast-forward pushes onto the current branch (the bare has
  // main checked out as HEAD) so the conflict-branch tests can push.
  await git(bare, 'config', 'receive.denyCurrentBranch', 'ignore');
  await exec('git', ['push', bare, 'main'], { cwd: seed });

  // Local clone from the bare — also bare, matching the runtime invariant.
  await exec('git', ['clone', '--bare', bare, local]);
  await git(local, 'config', 'user.email', 'local@test.local');
  await git(local, 'config', 'user.name', 'local');
  await git(local, 'config', 'commit.gpgsign', 'false');
  await git(local, 'config', 'core.hooksPath', '/dev/null');
  // A bare `git clone --bare` writes a narrow `+refs/heads/*:refs/heads/*`
  // refspec on origin. The reconciler always passes an explicit refspec
  // on fetch so this is fine for it, but make sure HEAD points at the
  // single-branch the test expects.
  await git(local, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  return {
    bare,
    local,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Mint a new commit onto a bare repo's `main` via an ephemeral working
 * tree clone. Used by both the local and remote helpers — the bare and
 * the workflow are symmetrical, just the target repo path differs.
 *
 * Returns the new HEAD hash.
 */
async function commitToBare(
  barePath: string,
  filename: string,
  contents: string,
  message: string,
): Promise<string> {
  const wt = `${barePath}-wt-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await exec('git', ['clone', barePath, wt]);
  await git(wt, 'config', 'user.email', 'commit-helper@test.local');
  await git(wt, 'config', 'user.name', 'commit-helper');
  await git(wt, 'config', 'commit.gpgsign', 'false');
  await git(wt, 'config', 'core.hooksPath', '/dev/null');
  await writeFile(join(wt, filename), contents);
  await git(wt, 'add', filename);
  await git(wt, 'commit', '-m', message);
  const head = await git(wt, 'rev-parse', 'HEAD');
  await git(wt, 'push', 'origin', 'main');
  await rm(wt, { recursive: true, force: true });
  return head;
}

/** Push a new commit onto the bare remote's `main` so it advances ahead of local. */
async function advanceRemote(
  rig: TestRig,
  filename: string,
  contents: string,
  message: string,
): Promise<string> {
  return commitToBare(rig.bare, filename, contents, message);
}

/** Push a new commit onto the local bare's `main` so it advances ahead of remote. */
async function advanceLocal(
  rig: TestRig,
  filename: string,
  contents: string,
  message: string,
): Promise<string> {
  return commitToBare(rig.local, filename, contents, message);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcileDataRepo', () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = await createRig();
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  it('returns "in-sync" when local HEAD matches remote', async () => {
    const { logger, lines } = makeLogger();
    const before = await git(rig.local, 'rev-parse', 'HEAD');

    const result = await reconcileDataRepo({
      repoPath: rig.local,
      branch: 'main',
      logger,
    });

    expect(result.outcome).toBe('in-sync');
    expect(result.oldCommit).toBe(before);
    expect(result.newCommit).toBe(before);
    // No errors logged.
    expect(lines.find((l) => l.level === 'error')).toBeUndefined();
  });

  it('"fast-forwarded" when local is behind remote', async () => {
    const before = await git(rig.local, 'rev-parse', 'HEAD');
    const remoteHead = await advanceRemote(rig, 'remote-feature.txt', 'hi\n', 'remote: add feature');

    const { logger, lines } = makeLogger();
    const result = await reconcileDataRepo({
      repoPath: rig.local,
      branch: 'main',
      logger,
    });

    expect(result.outcome).toBe('fast-forwarded');
    expect(result.oldCommit).toBe(before);
    expect(result.newCommit).toBe(remoteHead);
    expect(result.behind).toBe(1);

    const after = await git(rig.local, 'rev-parse', 'HEAD');
    expect(after).toBe(remoteHead);

    expect(lines.some((l) => l.msg.includes('fast-forwarding'))).toBe(true);
  });

  it('"pushed-ahead" when local is ahead of remote', async () => {
    const remoteBefore = await git(rig.bare, 'rev-parse', 'main');
    const newHead = await advanceLocal(rig, 'local-feature.txt', 'hi\n', 'local: add feature');

    const { logger } = makeLogger();
    const result = await reconcileDataRepo({
      repoPath: rig.local,
      branch: 'main',
      logger,
    });

    expect(result.outcome).toBe('pushed-ahead');
    expect(result.oldCommit).toBe(newHead);
    expect(result.newCommit).toBe(newHead);
    expect(result.ahead).toBe(1);

    // Remote should have advanced to local HEAD.
    const remoteAfter = await git(rig.bare, 'rev-parse', 'main');
    expect(remoteAfter).toBe(newHead);
    expect(remoteAfter).not.toBe(remoteBefore);
  });

  it('"rebased" when diverged with a clean rebase', async () => {
    // Local commits to a file the remote will never touch.
    const localHead = await advanceLocal(
      rig,
      'local-only.txt',
      'L\n',
      'local: independent change',
    );
    // Remote advances on a different file.
    const remoteHead = await advanceRemote(rig, 'remote-only.txt', 'R\n', 'remote: independent change');

    const { logger } = makeLogger();
    const result = await reconcileDataRepo({
      repoPath: rig.local,
      branch: 'main',
      logger,
    });

    expect(result.outcome).toBe('rebased');
    expect(result.oldCommit).toBe(localHead);
    expect(result.newCommit).not.toBe(localHead);
    expect(result.ahead).toBe(1);
    expect(result.behind).toBe(1);

    // After rebase, HEAD's parent should be remoteHead (the rebase base).
    const newHead = await git(rig.local, 'rev-parse', 'HEAD');
    const parent = await git(rig.local, 'rev-parse', 'HEAD^');
    expect(newHead).toBe(result.newCommit);
    expect(parent).toBe(remoteHead);

    // Remote was pushed to.
    const remoteAfter = await git(rig.bare, 'rev-parse', 'main');
    expect(remoteAfter).toBe(newHead);
  });

  it('"conflict-escaped" when diverged with a rebase conflict', async () => {
    // Both sides touch the same file with different content — guaranteed
    // rebase conflict.
    const localHead = await advanceLocal(rig, 'conflict.txt', 'LOCAL\n', 'local: edit shared file');
    await advanceRemote(rig, 'conflict.txt', 'REMOTE\n', 'remote: edit shared file');
    const remoteHead = await git(rig.bare, 'rev-parse', 'main');

    // Deterministic timestamp for the conflict branch name.
    const now = new Date('2026-08-15T12:34:56.789Z');
    const expectedBranch = 'conflicts/2026-08-15T12-34-56Z';

    const { logger, lines } = makeLogger();
    const result = await reconcileDataRepo({
      repoPath: rig.local,
      branch: 'main',
      logger,
      now: () => now,
    });

    expect(result.outcome).toBe('conflict-escaped');
    expect(result.conflictBranch).toBe(expectedBranch);
    expect(result.oldCommit).toBe(localHead);
    expect(result.newCommit).toBe(remoteHead);

    // Local HEAD reset to origin/main.
    const localHEAD = await git(rig.local, 'rev-parse', 'HEAD');
    expect(localHEAD).toBe(remoteHead);

    // No half-rebase left behind.
    let rebaseInProgress = false;
    try {
      await git(rig.local, 'rev-parse', '--verify', 'REBASE_HEAD');
      rebaseInProgress = true;
    } catch {
      // expected — no REBASE_HEAD ref means no in-progress rebase
    }
    expect(rebaseInProgress).toBe(false);

    // Conflict branch pushed to remote, pointing at the original local HEAD.
    const conflictRef = await git(rig.bare, 'rev-parse', `refs/heads/${expectedBranch}`);
    expect(conflictRef).toBe(localHead);

    // Loud error log line emitted.
    const errorLines = lines.filter((l) => l.level === 'error');
    expect(errorLines.length).toBeGreaterThan(0);
    // The escape-hatch outcome should mention the conflictBranch field.
    expect(
      errorLines.some(
        (l) =>
          'conflictBranch' in l.obj ||
          (typeof l.msg === 'string' && l.msg.includes('conflict')),
      ),
    ).toBe(true);
  });

  it('"fetch-failed" when the remote is unreachable; local state preserved', async () => {
    // Point origin at a bogus path. fetch will fail.
    await git(rig.local, 'remote', 'set-url', 'origin', '/definitely/not/a/repo/path');

    const before = await git(rig.local, 'rev-parse', 'HEAD');

    const { logger, lines } = makeLogger();
    const result = await reconcileDataRepo({
      repoPath: rig.local,
      branch: 'main',
      logger,
    });

    expect(result.outcome).toBe('fetch-failed');
    expect(result.oldCommit).toBe(before);
    expect(result.newCommit).toBe(before);

    // Local HEAD unchanged.
    const after = await git(rig.local, 'rev-parse', 'HEAD');
    expect(after).toBe(before);

    // Logger received a warn line for the fetch.
    expect(lines.some((l) => l.level === 'warn' && /fetch/.test(l.msg))).toBe(true);
  });

  it('reconciles correctly when refs/remotes/origin/<branch> is unpopulated (regression for the refspec bug)', async () => {
    // The original shell-side bug: `git clone --branch X` wrote a narrow
    // refspec, then later `git fetch origin Y` quietly failed to populate
    // `refs/remotes/origin/Y`. Our reconciler always passes an explicit
    // refspec — this test verifies that defense.
    //
    // A bare clone exhibits the same shape: `git clone --bare` writes
    // `+refs/heads/*:refs/heads/*` (mirroring to local refs/heads/),
    // leaving `refs/remotes/origin/main` unpopulated. With our explicit
    // refspec on fetch, reconcile still works.
    const altLocal = `${rig.local}-alt.git`;
    await exec('git', ['clone', '--bare', rig.bare, altLocal]);
    await git(altLocal, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    await git(altLocal, 'config', 'user.email', 'alt@test.local');
    await git(altLocal, 'config', 'user.name', 'alt');
    await git(altLocal, 'config', 'commit.gpgsign', 'false');

    // Sanity-check the test premise: origin/main is unset on the fresh bare.
    let originBranchExists = true;
    try {
      await git(altLocal, 'rev-parse', '--verify', 'refs/remotes/origin/main');
    } catch {
      originBranchExists = false;
    }
    expect(originBranchExists).toBe(false);

    // Advance the remote on `main`.
    const newRemoteHead = await advanceRemote(
      rig,
      'narrow-feature.txt',
      'hi\n',
      'remote: advance after bare clone',
    );

    const { logger } = makeLogger();
    const result = await reconcileDataRepo({
      repoPath: altLocal,
      branch: 'main',
      logger,
    });

    expect(result.outcome).toBe('fast-forwarded');
    expect(result.newCommit).toBe(newRemoteHead);

    await rm(altLocal, { recursive: true, force: true });
  });
});
