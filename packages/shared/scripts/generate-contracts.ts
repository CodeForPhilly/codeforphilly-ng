/**
 * Publish each public sheet's schema contract — specs/behaviors/storage.md →
 * "Schema contracts".
 *
 *   npm run -w packages/shared generate-contracts   # write contracts/…/v<N>.json
 *   npm run -w packages/shared check-contracts      # CI: fail on drift
 *
 * Writes `contracts/codeforphilly.org/<sheet>/v<N>.json` (repo root) from
 * `buildContract()` for every sheet's current version. Check mode writes
 * nothing; it fails when a current version's committed file is missing or
 * differs from what the Zod schema now generates. A difference means the
 * schema changed under a published version: bump that sheet's `version` in
 * `src/contracts.ts` (the old file stays, untouched).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHEET_CONTRACTS, buildContract, contractName, type ContractSheet } from '../src/contracts.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const check = process.argv.includes('--check');

function render(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const problems: string[] = [];
for (const sheet of Object.keys(SHEET_CONTRACTS) as ContractSheet[]) {
  const path = join(repoRoot, 'contracts', `${contractName(sheet)}.json`);
  const expected = render(buildContract(sheet));
  if (check) {
    const committed = await readFile(path, 'utf8').catch(() => null);
    if (committed === null) problems.push(`missing: contracts/${contractName(sheet)}.json`);
    else if (committed !== expected) {
      problems.push(
        `changed: contracts/${contractName(sheet)}.json — the ${sheet} schema no longer matches its ` +
          `published version; bump its version in packages/shared/src/contracts.ts`,
      );
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, expected);
  }
}

if (problems.length > 0) {
  console.error('Schema contracts are out of date:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `${Object.keys(SHEET_CONTRACTS).length} contracts ${check ? 'match their published files' : 'written'}.`,
);
