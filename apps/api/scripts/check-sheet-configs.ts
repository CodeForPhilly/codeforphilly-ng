/**
 * Verify the vendored sheet configs and schema contracts in
 * `apps/api/gitsheets/` match the data repo's `empty` branch, the source of
 * truth for everything under `.gitsheets/`
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
 * Exits 1 when a vendored config differs from upstream or is missing there.
 * A config only upstream (a sheet the app doesn't open yet) is a warning.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openRepo, type Repository } from 'gitsheets';

const exec = promisify(execFile);

// The data repo is private: SSH with a key that can read it (CI: a deploy key).
const DEFAULT_REMOTE = 'git@github.com:CodeForPhilly/codeforphilly-data.git';
const DEFAULT_REF = 'empty';
const VENDORED_DIR = join(dirname(fileURLToPath(import.meta.url)), '../gitsheets');

/** Every `.toml` file under `dir`, keyed by its path relative to `dir`. */
async function readTomlTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
    const abs = join(entry.parentPath, entry.name);
    out.set(relative(dir, abs), await readFile(abs, 'utf8'));
  }
  return out;
}

/** Every file path under `dir` at `ref`, recursively. */
async function listFilesUnder(repo: Repository, ref: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await repo.listTree(ref, dir)) ?? []) {
    const path = `${dir}/${entry.name}`;
    if (entry.type === 'tree') out.push(...(await listFilesUnder(repo, ref, path)));
    else if (entry.type === 'blob') out.push(path);
  }
  return out;
}

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function main(): Promise<number> {
  const remote = arg('remote', DEFAULT_REMOTE);
  const ref = arg('ref', DEFAULT_REF);

  const gitDir = await mkdtemp(join(tmpdir(), 'cfp-sheet-configs-'));
  try {
    // Raw git: gitsheets has no init, and fetches only from a named remote.
    await exec('git', ['init', '--bare', '-q', gitDir]);
    await exec('git', ['--git-dir', gitDir, 'remote', 'add', 'origin', remote]);
    const repo = await openRepo({ gitDir });
    const fetched = await repo.fetch({ remote: 'origin', branch: ref });
    if (!fetched.ok) throw new Error(`fetching ${remote}#${ref} failed: ${fetched.error}`);

    const upstream = new Map<string, string>();
    for (const path of await listFilesUnder(repo, fetched.remoteCommit, '.gitsheets')) {
      if (!path.endsWith('.toml')) continue;
      const blob = await repo.readBlob(fetched.remoteCommit, path);
      upstream.set(path.slice('.gitsheets/'.length), (await blob.read()).toString('utf8'));
    }

    const vendored = await readTomlTree(VENDORED_DIR);

    // A sheet lands in the data repo before the app opens it, so a config
    // only upstream is expected mid-change: warn. Anything the app vendors
    // must match upstream exactly.
    const problems: string[] = [];
    const upstreamOnly: string[] = [];
    for (const [name, contents] of upstream) {
      const ours = vendored.get(name);
      if (ours === undefined) upstreamOnly.push(name);
      else if (ours !== contents) problems.push(`differs: ${name}`);
    }
    for (const name of vendored.keys()) {
      if (!upstream.has(name)) problems.push(`not in ${ref}: ${name}`);
    }

    for (const name of upstreamOnly) {
      const msg = `${name} is in ${ref} but not vendored in apps/api/gitsheets/ (expected while a new sheet is landing)`;
      console.warn(process.env.GITHUB_ACTIONS ? `::warning title=Sheet config not vendored::${msg}` : `warning: ${msg}`);
    }

    if (problems.length > 0) {
      console.error(`Sheet configs in apps/api/gitsheets/ drift from ${remote}#${ref}:`);
      for (const p of problems) console.error(`  - ${p}`);
      return 1;
    }
    console.log(`${vendored.size} files under .gitsheets/ match ${remote}#${ref}.`);
    return 0;
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
}

process.exit(await main());
