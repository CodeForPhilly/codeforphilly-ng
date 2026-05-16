// Seed a local development data repo with the minimal sheet configs the API
// needs to boot. Run once after `cp .env.example .env`:
//
//   npm run -w apps/api script:setup-dev-data [-- <path>]
//
// `<path>` defaults to the value of `CFP_DATA_REPO_PATH` in the env, or
// `../codeforphilly-data` if unset.
//
// What this does:
//   1. Creates the directory if missing
//   2. `git init -b main` if not already a repo
//   3. Writes one `.gitsheets/<sheet>.toml` per declared sheet (minimal
//      `[gitsheet]` block — root + a placeholder path template)
//   4. Commits as `initial: dev data repo configs`
//
// The path templates here are dev-stub defaults, not authoritative. The real
// templates are authored alongside the production data repo. For an empty
// dev repo with no records, the path template doesn't matter at boot — only
// the existence of `.gitsheets/<sheet>.toml` does.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const SHEET_CONFIGS: ReadonlyArray<{ name: string; root: string; path: string }> = [
  { name: 'people', root: 'people', path: '${{ slug }}' },
  { name: 'projects', root: 'projects', path: '${{ slug }}' },
  { name: 'project-memberships', root: 'project-memberships', path: '${{ projectSlug }}/${{ personSlug }}' },
  { name: 'project-updates', root: 'project-updates', path: '${{ projectSlug }}/${{ number }}' },
  { name: 'project-buzz', root: 'project-buzz', path: '${{ projectSlug }}/${{ slug }}' },
  { name: 'help-wanted-roles', root: 'help-wanted-roles', path: '${{ projectSlug }}/${{ slug }}' },
  { name: 'help-wanted-interest', root: 'help-wanted-interest', path: '${{ roleId }}/${{ personId }}' },
  { name: 'tags', root: 'tags', path: '${{ namespace }}/${{ slug }}' },
  { name: 'tag-assignments', root: 'tag-assignments', path: '${{ taggableType }}/${{ taggableId }}/${{ tagId }}' },
  { name: 'slug-history', root: 'slug-history', path: '${{ entityType }}/${{ slug }}' },
  { name: 'revocations', root: 'revocations', path: '${{ jti }}' },
];

function configToml(root: string, path: string): string {
  return `[gitsheet]\nroot = '${root}'\npath = '${path}'\n`;
}

async function main(): Promise<void> {
  const argPath = process.argv[2];
  const envPath = process.env['CFP_DATA_REPO_PATH'];
  const targetPath = resolve(argPath ?? envPath ?? '../codeforphilly-data');

  console.log(`[setup-dev-data] target: ${targetPath}`);

  if (!existsSync(targetPath)) {
    await mkdir(targetPath, { recursive: true });
    console.log(`[setup-dev-data] created directory`);
  }

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await exec('git', args, { cwd: targetPath });
    return stdout;
  };

  if (!existsSync(join(targetPath, '.git'))) {
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'dev@local');
    await git('config', 'user.name', 'Dev');
    await git('commit', '--allow-empty', '-m', 'initial');
    console.log(`[setup-dev-data] initialized git repo`);
  }

  const gitsheetsDir = join(targetPath, '.gitsheets');
  await mkdir(gitsheetsDir, { recursive: true });

  let wroteAny = false;
  for (const { name, root, path } of SHEET_CONFIGS) {
    const configPath = join(gitsheetsDir, `${name}.toml`);
    if (existsSync(configPath)) {
      console.log(`[setup-dev-data] skip ${name}.toml (already exists)`);
      continue;
    }
    await writeFile(configPath, configToml(root, path), 'utf8');
    wroteAny = true;
    console.log(`[setup-dev-data] wrote ${name}.toml`);
  }

  if (!wroteAny) {
    console.log(`[setup-dev-data] all sheet configs already present — nothing to commit`);
    return;
  }

  await git('add', '.gitsheets');
  const { stdout: porcelain } = await exec('git', ['status', '--porcelain'], { cwd: targetPath });
  if (porcelain.trim() === '') {
    console.log(`[setup-dev-data] nothing to commit (configs were unchanged)`);
    return;
  }
  await git('commit', '-m', 'initial: dev data repo configs');
  console.log(`[setup-dev-data] committed sheet configs`);
}

main().catch((err: unknown) => {
  console.error(`[setup-dev-data] failed:`, err);
  process.exit(1);
});
