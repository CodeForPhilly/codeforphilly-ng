/**
 * import-laddr.ts — Re-runnable import from the live laddr site at
 * codeforphilly.org into the public `codeforphilly-data` repo.
 *
 * Each run produces one new commit on the `legacy-import` branch whose tree
 * is a complete replacement of the previous snapshot. Consecutive commits
 * diff cleanly to show what changed upstream between runs.
 *
 * Usage:
 *   npm run -w apps/api script:import-laddr -- \
 *     --source-host=codeforphilly.org \
 *     --data-repo=/path/to/codeforphilly-data \
 *     --branch=legacy-import \
 *     [--dry-run] [--limit=N] [--verbose] [--page-size=N] [--delay-ms=N]
 *
 * Defaults:
 *   --source-host  codeforphilly.org
 *   --data-repo    $CFP_DATA_REPO_PATH (required if flag not given)
 *   --branch       legacy-import
 *
 * See plans/laddr-import-via-json.md for the design and
 * specs/behaviors/legacy-id-mapping.md for the contract.
 */
import { resolve } from 'node:path';

import { importLaddrFromJson, type ImportReport } from './import-laddr/importer.js';

interface CliArgs {
  readonly sourceHost: string;
  readonly dataRepo: string;
  readonly branch: string;
  readonly dryRun: boolean;
  readonly limit: number | undefined;
  readonly verbose: boolean;
  readonly pageSize: number | undefined;
  readonly delayMs: number | undefined;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const opts: Record<string, string | true> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) opts[a.slice(2)] = true;
    else opts[a.slice(2, eq)] = a.slice(eq + 1);
  }

  const envRepo = process.env['CFP_DATA_REPO_PATH'];
  const dataRepoRaw =
    typeof opts['data-repo'] === 'string' && opts['data-repo'] !== ''
      ? (opts['data-repo'] as string)
      : envRepo;
  if (!dataRepoRaw) {
    process.stderr.write(
      'missing --data-repo=<path> (or set CFP_DATA_REPO_PATH)\n',
    );
    process.exit(2);
  }

  const limitRaw = opts['limit'];
  const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : undefined;
  const pageSizeRaw = opts['page-size'];
  const pageSize = typeof pageSizeRaw === 'string' ? Number.parseInt(pageSizeRaw, 10) : undefined;
  const delayMsRaw = opts['delay-ms'];
  const delayMs = typeof delayMsRaw === 'string' ? Number.parseInt(delayMsRaw, 10) : undefined;

  return {
    sourceHost:
      typeof opts['source-host'] === 'string' && opts['source-host'] !== ''
        ? (opts['source-host'] as string)
        : 'codeforphilly.org',
    dataRepo: resolve(dataRepoRaw),
    branch:
      typeof opts['branch'] === 'string' && opts['branch'] !== ''
        ? (opts['branch'] as string)
        : 'legacy-import',
    dryRun: opts['dry-run'] === true,
    limit: typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined,
    verbose: opts['verbose'] === true,
    pageSize: typeof pageSize === 'number' && Number.isFinite(pageSize) ? pageSize : undefined,
    delayMs: typeof delayMs === 'number' && Number.isFinite(delayMs) ? delayMs : undefined,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[import-laddr] source-host=${args.sourceHost}`);
  console.log(`[import-laddr] data-repo=${args.dataRepo}`);
  console.log(`[import-laddr] branch=${args.branch}`);
  console.log(`[import-laddr] dry-run=${args.dryRun} limit=${args.limit ?? 'none'}`);

  const report = await importLaddrFromJson({
    sourceHost: args.sourceHost,
    dataRepo: args.dataRepo,
    branch: args.branch,
    dryRun: args.dryRun,
    limit: args.limit,
    verbose: args.verbose,
    pageSize: args.pageSize,
    delayMs: args.delayMs,
  });

  printReport(report, args);
}

function printReport(report: ImportReport, args: CliArgs): void {
  const lines: string[] = [];
  lines.push(`\n=== import-laddr report ===`);
  lines.push(`runAt:       ${report.runAt}`);
  lines.push(`sourceHost:  ${report.sourceHost}`);
  lines.push(`branch:      ${report.branch}`);
  for (const [sheet, c] of Object.entries(report.counts)) {
    lines.push(
      `  ${sheet.padEnd(22)} imported=${c.imported} skipped=${c.skipped} errors=${c.errors}`,
    );
  }
  lines.push(`warnings: ${report.warnings.length}`);
  for (const w of report.warnings.slice(0, 25)) lines.push(`  ${w}`);
  if (report.warnings.length > 25) {
    lines.push(`  ... (${report.warnings.length - 25} more)`);
  }
  if (args.dryRun) {
    lines.push(`(dry-run: no writes performed)`);
  } else if (report.noChanges) {
    lines.push(`(no changes from parent commit — branch unchanged)`);
  } else if (report.commitHash) {
    lines.push(`commit: ${report.commitHash} on ${report.branch}`);
  }
  console.log(lines.join('\n'));
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
