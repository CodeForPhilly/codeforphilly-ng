/**
 * Verify the vendored sheet configs in `apps/api/gitsheets/` match the data
 * repo's `empty` branch, the source of truth for `.gitsheets/*.toml`
 * (specs/behaviors/storage.md → "Why these path shapes").
 *
 * Tests seed every test data repo from the vendored copy, so drift between
 * it and the data repo means tests no longer exercise production's path
 * templates — which is how a broken slug-history template shipped
 * (plans/slug-history-config.md).
 *
 * Usage:
 *   npm run -w apps/api check:sheet-configs [-- --remote=<url>] [-- --ref=<branch>]
 *
 * Exits 1 and prints each differing, missing, or extra config on drift.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const DEFAULT_REMOTE = 'https://github.com/CodeForPhilly/codeforphilly-data.git';
const DEFAULT_REF = 'empty';
const VENDORED_DIR = join(dirname(fileURLToPath(import.meta.url)), '../gitsheets');

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function main(): Promise<number> {
  const remote = arg('remote', DEFAULT_REMOTE);
  const ref = arg('ref', DEFAULT_REF);

  const gitDir = await mkdtemp(join(tmpdir(), 'cfp-sheet-configs-'));
  try {
    const git = (...args: string[]) => exec('git', ['--git-dir', gitDir, ...args]);
    await exec('git', ['init', '--bare', '-q', gitDir]);
    await git('fetch', '-q', '--depth=1', remote, ref);

    const { stdout: listing } = await git('ls-tree', '--name-only', 'FETCH_HEAD', '.gitsheets/');
    const upstream = new Map<string, string>();
    for (const path of listing.split('\n').filter((p) => p.endsWith('.toml'))) {
      const { stdout } = await git('show', `FETCH_HEAD:${path}`);
      upstream.set(path.slice('.gitsheets/'.length), stdout);
    }

    const vendored = new Map<string, string>();
    for (const name of (await readdir(VENDORED_DIR)).filter((f) => f.endsWith('.toml'))) {
      vendored.set(name, await readFile(join(VENDORED_DIR, name), 'utf8'));
    }

    const problems: string[] = [];
    for (const [name, contents] of upstream) {
      const ours = vendored.get(name);
      if (ours === undefined) problems.push(`missing locally: ${name}`);
      else if (ours !== contents) problems.push(`differs: ${name}`);
    }
    for (const name of vendored.keys()) {
      if (!upstream.has(name)) problems.push(`not in ${ref}: ${name}`);
    }

    if (problems.length > 0) {
      console.error(`Sheet configs in apps/api/gitsheets/ drift from ${remote}#${ref}:`);
      for (const p of problems) console.error(`  - ${p}`);
      return 1;
    }
    console.log(`${vendored.size} sheet configs match ${remote}#${ref}.`);
    return 0;
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
}

process.exit(await main());
