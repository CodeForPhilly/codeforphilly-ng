/**
 * The canonical `.gitsheets/` sheet configs and schema contracts, vendored
 * from the data repo's `empty` branch into `apps/api/gitsheets/`. Every test data repo is
 * seeded from these so tests run against the same path templates production
 * does. `npm run -w apps/api check:sheet-configs` verifies the vendored copy
 * still matches the data repo.
 */
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHEET_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../gitsheets');

/** Map of sheet name → config file contents. */
export async function loadSheetConfigs(
  only?: readonly string[],
): Promise<Record<string, string>> {
  const names = (await readdir(SHEET_CONFIG_DIR))
    .filter((f) => f.endsWith('.toml'))
    .map((f) => f.replace(/\.toml$/, ''))
    .filter((n) => !only || only.includes(n));
  const entries = await Promise.all(
    names.map(async (n) => [n, await readFile(join(SHEET_CONFIG_DIR, `${n}.toml`), 'utf8')] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * Write the canonical configs into `<dir>/.gitsheets/`, plus the vendored
 * schema contracts (`contracts/`) that sheet configs may declare.
 */
export async function writeSheetConfigs(dir: string, only?: readonly string[]): Promise<void> {
  await mkdir(join(dir, '.gitsheets'), { recursive: true });
  for (const [name, contents] of Object.entries(await loadSheetConfigs(only))) {
    await writeFile(join(dir, '.gitsheets', `${name}.toml`), contents);
  }
  await cp(join(SHEET_CONFIG_DIR, 'contracts'), join(dir, '.gitsheets', 'contracts'), {
    recursive: true,
  });
}
