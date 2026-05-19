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
 * Initialize a tracked working tree at a tmpdir + a corresponding bare
 * "remote" repo. Returns paths + cleanup. The local tree is cloned from
 * the bare via filesystem URL so push/fetch round-trip locally.
 *
 * Both initial commits live on `main`; the local working tree is on `main`.
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
  const local = join(root, 'local');

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
  // The bare needs to allow non-fast-forward pushes for the conflict-branch
  // tests; default git allows that for branch creation but the bare needs
  // `receive.denyCurrentBranch=warn` so pushes to `main` succeed (the
  // bare has main checked out as HEAD).
  await git(bare, 'config', 'receive.denyCurrentBranch', 'ignore');
  await exec('git', ['push', bare, 'main'], { cwd: seed });

  // Local clone from the bare.
  await exec('git', ['clone', bare, local]);
  await git(local, 'config', 'user.email', 'local@test.local');
  await git(local, 'config', 'user.name', 'local');
  await git(local, 'config', 'commit.gpgsign', 'false');
  await git(local, 'config', 'core.hooksPath', '/dev/null');
  // git clone may pick up the global remote.origin.fetch refspec; make sure
  // it's the standard "all branches" refspec so fetch works as expected.
  // (The reconciler will override per-call anyway, but the bare/seed plumbing
  //  uses plain `git push`/`git fetch` from the test helpers.)

  return {
    bare,
    local,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Commit a file into a working tree and return the new HEAD. */
async function commitFile(
  cwd: string,
  filename: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(join(cwd, filename), contents);
  await git(cwd, 'add', filename);
  await git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * Push a new commit onto the bare's `main` by way of an ephemeral working
 * tree clone, so the bare advances ahead of `local`.
 */
async function advanceRemote(
  rig: TestRig,
  filename: string,
  contents: string,
  message: string,
): Promise<string> {
  const wt = `${rig.local}-remote-advance-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await exec('git', ['clone', rig.bare, wt]);
  await git(wt, 'config', 'user.email', 'remote-advance@test.local');
  await git(wt, 'config', 'user.name', 'remote-advance');
  await git(wt, 'config', 'commit.gpgsign', 'false');
  await git(wt, 'config', 'core.hooksPath', '/dev/null');
  const head = await commitFile(wt, filename, contents, message);
  await git(wt, 'push', 'origin', 'main');
  await rm(wt, { recursive: true, force: true });
  return head;
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
    const remoteBefore = await git(rig.local, 'rev-parse', 'origin/main');
    const newHead = await commitFile(rig.local, 'local-feature.txt', 'hi\n', 'local: add feature');

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
    const localHead = await commitFile(
      rig.local,
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
    const localHead = await commitFile(rig.local, 'conflict.txt', 'LOCAL\n', 'local: edit shared file');
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

  it('reconciles correctly after a single-branch clone (regression for the shell bug)', async () => {
    // The shell entrypoint used `git clone --branch X` then `git fetch origin Y`
    // which wrote a narrow remote refspec and quietly failed to populate
    // refs/remotes/origin/Y. Our Node reconciler always passes an explicit
    // refspec — this test exercises a clone-with-a-narrow-refspec setup and
    // confirms reconciliation still works.

    // Start a fresh local from scratch, with a narrow remote.origin.fetch
    // refspec that mimics what `git clone --single-branch --branch main` writes.
    const narrowLocal = `${rig.local}-narrow`;
    await exec('git', ['clone', '--single-branch', '--branch', 'main', rig.bare, narrowLocal]);
    await git(narrowLocal, 'config', 'user.email', 'narrow@test.local');
    await git(narrowLocal, 'config', 'user.name', 'narrow');
    await git(narrowLocal, 'config', 'commit.gpgsign', 'false');
    await git(narrowLocal, 'config', 'core.hooksPath', '/dev/null');

    // Advance the remote on `main`.
    const newRemoteHead = await advanceRemote(
      rig,
      'narrow-feature.txt',
      'hi\n',
      'remote: advance after narrow clone',
    );

    const { logger } = makeLogger();
    const result = await reconcileDataRepo({
      repoPath: narrowLocal,
      branch: 'main',
      logger,
    });

    expect(result.outcome).toBe('fast-forwarded');
    expect(result.newCommit).toBe(newRemoteHead);

    await rm(narrowLocal, { recursive: true, force: true });
  });
});
