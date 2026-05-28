import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { openRepo, type Repository } from 'gitsheets';

const exec = promisify(execFile);

type GitRunner = (...args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface AppTestRepo {
  readonly repo: Repository;
  /** Absolute path to the working tree. */
  readonly path: string;
  /** Remove the temp directory. Idempotent. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Create an isolated git repo in a tmpdir, commit a minimal
 * `.gitsheets/<name>.toml` for each sheet name provided, and return a
 * wired-up gitsheets Repository.
 *
 * Each sheet config uses a single-level `path = '${{ slug }}'` template
 * under a `root` matching the sheet name. This shape is sufficient for
 * placeholder tests and simple fixtures; real configs will come from
 * packages/shared once storage-foundation lands.
 */
export async function createTestRepo(
  sheetNames: readonly string[] = [],
): Promise<AppTestRepo> {
  const root = await mkdtemp(join(tmpdir(), 'cfp-test-'));
  const bareDir = join(root, 'data.git');
  const seedDir = join(root, 'seed');

  // Bare repo — the path the test code reads as a gitsheets store. Matches
  // the production bare-repo invariant (specs/behaviors/storage.md).
  await exec('git', ['init', '--bare', '-b', 'main', bareDir]);
  // Allow pushes to the currently-checked-out branch on the bare so the
  // seed step's `git push` lands.
  await exec('git', ['config', 'receive.denyCurrentBranch', 'ignore'], { cwd: bareDir });

  // Transient working-tree clone used only for the seed commits.
  await exec('git', ['init', '-b', 'main', seedDir]);
  const seedGit: GitRunner = (...args) => exec('git', args, { cwd: seedDir });
  await seedGit('config', 'user.email', 'test@cfp.test');
  await seedGit('config', 'user.name', 'cfp test');
  await seedGit('config', 'commit.gpgsign', 'false');
  await seedGit('config', 'core.hooksPath', '/dev/null');
  await seedGit('commit', '--allow-empty', '-m', 'initial');

  if (sheetNames.length > 0) {
    await mkdir(join(seedDir, '.gitsheets'), { recursive: true });
    for (const name of sheetNames) {
      const config =
        `[gitsheet]\n` +
        `root = '${name}'\n` +
        `path = '\${{ slug }}'\n`;
      await writeFile(join(seedDir, '.gitsheets', `${name}.toml`), config);
    }
    await seedGit('add', '.gitsheets');
    await seedGit('commit', '-m', `chore: add sheet configs (${sheetNames.join(', ')})`);
  }

  await seedGit('remote', 'add', 'origin', bareDir);
  await seedGit('push', 'origin', 'main');
  // Discard the transient working tree — only the bare matters from here on.
  // maxRetries: Linux ext4 + git background pack work races bare rmdir.
  await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  const repo = await openRepo({ gitDir: bareDir });

  let cleaned = false;
  return {
    repo,
    path: bareDir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Upsert records into a named sheet inside a transaction.
 * Each record must contain a `slug` field (used by the path template).
 */
export async function seed(
  repo: Repository,
  sheetName: string,
  records: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  await repo.transact(
    { message: `seed: ${sheetName}`, author: { name: 'test', email: 'test@cfp.test' } },
    async (tx) => {
      const sheet = tx.sheet(sheetName);
      for (const record of records) {
        await sheet.upsert(record);
      }
    },
  );
}
