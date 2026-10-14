/**
 * Test helper: create a full gitsheets data repo.
 *
 * Creates a temporary git repo seeded with the canonical .gitsheets/*.toml
 * sheet configs (apps/api/gitsheets/, see helpers/sheet-configs.ts).
 *
 * Used by api-skeleton tests (and any future tests) that boot the full app
 * via buildApp() and need a real gitsheets-backed data repo.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { writeSheetConfigs } from './sheet-configs.js';

const execFileAsync = promisify(execFile);

export interface FullTestRepo {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Create a full gitsheets data repo in a temp directory, with all sheet
 * configs required by openPublicStore().
 *
 * This is the data-repo analog of createTestRepo() from test-repo.ts — but
 * for full-app tests where the store plugin boots the real openPublicStore().
 */
export async function createFullDataRepo(): Promise<FullTestRepo> {
  const root = await mkdtemp(join(tmpdir(), 'cfp-full-data-'));
  const bareDir = join(root, 'data.git');
  const seedDir = join(root, 'seed');

  // Bare gitdir — the path tests pass to openPublicStore. Matches the
  // production bare-repo invariant (specs/behaviors/storage.md).
  await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);
  await execFileAsync('git', ['config', 'receive.denyCurrentBranch', 'ignore'], { cwd: bareDir });

  // Transient working-tree clone for seeding the sheet configs.
  await execFileAsync('git', ['init', '-b', 'main', seedDir]);
  const seedGit = (...args: string[]) => execFileAsync('git', args, { cwd: seedDir });
  await seedGit('config', 'user.email', 'test@cfp.test');
  await seedGit('config', 'user.name', 'cfp test');
  await seedGit('config', 'commit.gpgsign', 'false');
  await seedGit('config', 'core.hooksPath', '/dev/null');
  await seedGit('commit', '--allow-empty', '-m', 'initial');

  await writeSheetConfigs(seedDir);
  await seedGit('add', '.gitsheets');
  await seedGit('commit', '-m', 'chore: add all gitsheets sheet configs');

  await seedGit('remote', 'add', 'origin', bareDir);
  await seedGit('push', 'origin', 'main');
  // maxRetries: Linux ext4 + git background pack work races bare rmdir.
  await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  let cleaned = false;
  return {
    path: bareDir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Create a temp directory for the filesystem private store.
 */
export async function createPrivateStorageDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cfp-private-'));
  await mkdir(dir, { recursive: true });

  let cleaned = false;
  return {
    path: dir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
