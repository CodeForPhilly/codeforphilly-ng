/**
 * import-laddr.ts — One-shot migration from a laddr mysqldump
 *
 * Reads a mysqldump (`--sql`), translates each row to the v1 data model
 * (Zod-validated against `@cfp/shared/schemas`), and writes records into:
 *
 *   - the public gitsheets data repo (`--data-repo`)
 *   - the private filesystem store (`--private-store`)
 *
 * Idempotent on `legacyId`: re-running against the same dump + target
 * skips rows already present. See specs/behaviors/legacy-id-mapping.md.
 *
 * Usage:
 *   npm run -w apps/api script:import-laddr -- \
 *     --sql=./scratch/laddr.sql \
 *     --data-repo=./codeforphilly-data \
 *     --private-store=./scratch/private-storage \
 *     [--dry-run] [--verbose] [--limit=N]
 */
import { resolve } from 'node:path';

import { FilesystemPrivateStore } from '../src/store/private/filesystem.js';
import { importLaddr, type ImportReport } from './import-laddr/importer.js';

interface CliArgs {
  readonly sql: string;
  readonly dataRepo: string;
  readonly privateStore: string;
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly limit: number | undefined;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const opts: Record<string, string | true> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) opts[a.slice(2)] = true;
    else opts[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const need = (k: string): string => {
    const v = opts[k];
    if (typeof v !== 'string' || !v) {
      process.stderr.write(`missing --${k}=<path>\n`);
      process.exit(2);
    }
    return v;
  };
  const limitRaw = opts['limit'];
  const limit =
    typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : undefined;

  return {
    sql: resolve(need('sql')),
    dataRepo: resolve(need('data-repo')),
    privateStore: resolve(need('private-store')),
    dryRun: opts['dry-run'] === true,
    verbose: opts['verbose'] === true,
    limit: Number.isFinite(limit ?? NaN) ? limit : undefined,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const privateStore = new FilesystemPrivateStore({
    CFP_PRIVATE_STORAGE_PATH: args.privateStore,
  });
  await privateStore.load();

  console.log(`[import-laddr] sql=${args.sql}`);
  console.log(`[import-laddr] data-repo=${args.dataRepo}`);
  console.log(`[import-laddr] private-store=${args.privateStore}`);
  console.log(`[import-laddr] dry-run=${args.dryRun} limit=${args.limit ?? 'none'}`);

  const report = await importLaddr({
    sql: args.sql,
    dataRepo: args.dataRepo,
    privateStore,
    dryRun: args.dryRun,
    verbose: args.verbose,
    limit: args.limit,
  });

  printReport(report, args.dryRun);
}

function printReport(report: ImportReport, dryRun: boolean): void {
  const lines: string[] = [];
  lines.push(`\n=== import-laddr report ===`);
  lines.push(`runAt:        ${report.runAt}`);
  lines.push(`sourceSha256: ${report.sourceSha256}`);
  for (const [sheet, r] of Object.entries(report.entities)) {
    lines.push(
      `  ${sheet.padEnd(22)} input=${r.input} imported=${r.imported} skipped=${r.skipped} errors=${r.errors}`,
    );
  }
  lines.push(`warnings: ${report.warnings.length}`);
  for (const w of report.warnings.slice(0, 25)) lines.push(`  ${w}`);
  if (report.warnings.length > 25) {
    lines.push(`  ... (${report.warnings.length - 25} more)`);
  }
  if (dryRun) {
    lines.push(`(dry-run: no writes performed)`);
  } else {
    lines.push(`commits: ${report.commits.length}`);
    for (const c of report.commits) lines.push(`  ${c}`);
  }
  console.log(lines.join('\n'));

  process.stdout.write(`\n${JSON.stringify(reportToJson(report), null, 2)}\n`);
}

function reportToJson(report: ImportReport): unknown {
  return {
    runAt: report.runAt,
    sourceSha256: report.sourceSha256,
    entities: report.entities,
    warnings: report.warnings,
    commits: report.commits,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  main().catch((err: unknown) => {
    console.error('[import-laddr] failed:', err);
    process.exit(1);
  });
}
