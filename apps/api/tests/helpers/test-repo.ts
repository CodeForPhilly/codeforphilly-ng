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
  const dir = await mkdtemp(join(tmpdir(), 'cfp-test-'));
  const gitDir = join(dir, '.git');

  const git: GitRunner = (...args) => exec('git', args, { cwd: dir });

  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@cfp.test');
  await git('config', 'user.name', 'cfp test');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'core.hooksPath', '/dev/null');
  await git('commit', '--allow-empty', '-m', 'initial');

  if (sheetNames.length > 0) {
    await mkdir(join(dir, '.gitsheets'), { recursive: true });
    for (const name of sheetNames) {
      const config =
        `[gitsheet]\n` +
        `root = '${name}'\n` +
        `path = '\${{ slug }}'\n`;
      await writeFile(join(dir, '.gitsheets', `${name}.toml`), config);
    }
    await git('add', '.gitsheets');
    await git('commit', '-m', `chore: add sheet configs (${sheetNames.join(', ')})`);
  }

  const repo = await openRepo({ gitDir, workTree: dir });

  let cleaned = false;
  return {
    repo,
    path: dir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(dir, { recursive: true, force: true });
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
