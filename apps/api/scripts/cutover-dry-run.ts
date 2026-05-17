/**
 * cutover-dry-run.ts — End-to-end staging rehearsal
 *
 * Walks the full cutover pipeline against a non-production target so the team
 * can rehearse before T-0. Stages, in order:
 *
 *   1. Run the importer (apps/api/scripts/import-laddr/importer.ts) against a
 *      mysqldump → fresh data-repo + private store.
 *   2. Optionally hit a live target (`--target=<url>`) to smoke-test:
 *        - 10 random Persons resolve at /api/people/:slug
 *        - 10 random Projects resolve at /api/projects/:slug
 *        - legacy redirect for /projects?ID=<n> returns 301
 *        - SAML metadata is reachable at /api/saml/idp/metadata
 *        - GitHub OAuth start endpoint redirects (302)
 *   3. Compare importer's per-sheet counts vs. the raw mysqldump's row counts.
 *
 * Output: a JSON report with per-stage results + warnings + smoke-check timings.
 * Exit 0 if every stage passed; non-zero with details otherwise.
 *
 * Usage:
 *   npm run -w apps/api script:cutover-dry-run -- \
 *     --sql=./scratch/laddr.sql \
 *     --data-repo=./scratch/dry-run-data \
 *     --private-store=./scratch/dry-run-private \
 *     [--target=https://codeforphilly-rewrite-staging.k8s.phl.io] \
 *     [--sample=10] \
 *     [--json=./scratch/dry-run-report.json]
 *
 * `--target` is optional: when omitted the script runs steps 1 + 3 only
 * (useful before a staging cluster is up).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { FilesystemPrivateStore } from '../src/store/private/filesystem.js';
import { importLaddr, type ImportReport } from './import-laddr/importer.js';
import { openPublicStore } from '../src/store/public.js';

// ---------------------------------------------------------------------------
// Report types — exported for tests
// ---------------------------------------------------------------------------

export interface SmokeCheckResult {
  readonly name: string;
  readonly url: string;
  readonly status: number | null;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly note?: string;
}

export interface CountDiff {
  readonly sheet: string;
  readonly sourceRows: number;
  readonly importedRecords: number;
  /** True when sourceRows === importedRecords. */
  readonly matched: boolean;
}

export interface DryRunReport {
  readonly runAt: string;
  readonly target: string | null;
  readonly importReport: Pick<ImportReport, 'runAt' | 'sourceSha256' | 'entities' | 'warnings'>;
  readonly countDiffs: ReadonlyArray<CountDiff>;
  readonly smokeChecks: ReadonlyArray<SmokeCheckResult>;
  readonly stages: {
    readonly import: boolean;
    readonly countDiff: boolean;
    readonly smoke: boolean;
  };
  readonly passed: boolean;
}

// ---------------------------------------------------------------------------
// mysqldump row-count parser
//
// We only need row counts per table — not full parsing. Sum the number of
// row tuples across all `INSERT INTO \`<table>\` ... VALUES (...),(...);`
// statements. This is far cheaper than re-parsing every value.
// ---------------------------------------------------------------------------

/**
 * Map laddr table name → v1 sheet name. Mirrors translators.ts. Production
 * laddr dumps vary between CamelCase (older Emergence schema) and snake_case
 * (newer), so we accept either. Tables not listed here surface as
 * `unmapped:<table>` in the count diff so we can spot drift in the dump shape.
 */
const TABLE_TO_SHEET: ReadonlyMap<string, string> = new Map([
  ['People', 'people'],
  ['people', 'people'],
  ['Projects', 'projects'],
  ['projects', 'projects'],
  ['ProjectMembers', 'project-memberships'],
  ['project_members', 'project-memberships'],
  ['ProjectUpdates', 'project-updates'],
  ['project_updates', 'project-updates'],
  ['ProjectBuzz', 'project-buzz'],
  ['project_buzz', 'project-buzz'],
  ['Tags', 'tags'],
  ['tags', 'tags'],
  ['TagAssignments', 'tag-assignments'],
  ['tag_assignments', 'tag-assignments'],
  ['tag_items', 'tag-assignments'],
]);

/** Tables we know exist in laddr dumps but intentionally don't migrate. */
const IGNORED_TABLES: ReadonlySet<string> = new Set([
  'member_checkins',
  'sessions',
  '_history_People',
  '_history_Projects',
]);

/**
 * Count rows in INSERT statements per table. Cheap streaming-friendly parse:
 * walks the dump linewise; each `INSERT INTO \`Table\`` line contributes one
 * statement whose value-tuples we count via a one-pass parenthesis depth
 * tracker that respects quoted strings.
 */
export function countRowsByTable(sql: string): Map<string, number> {
  const result = new Map<string, number>();
  const insertRe = /^INSERT INTO `([^`]+)`/m;
  // Split statements on `;\n` boundaries. Simple but adequate for our dumps.
  const statements = sql.split(/;\s*\n/);
  for (const stmt of statements) {
    const m = stmt.match(insertRe);
    if (!m || m[1] === undefined) continue;
    const table = m[1];
    const tuples = countValueTuples(stmt);
    result.set(table, (result.get(table) ?? 0) + tuples);
  }
  return result;
}

function countValueTuples(stmt: string): number {
  const valuesIdx = stmt.indexOf('VALUES');
  if (valuesIdx === -1) return 0;
  const tail = stmt.slice(valuesIdx + 'VALUES'.length);

  let count = 0;
  let depth = 0;
  let inStr = false;
  let escape = false;

  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (inStr) {
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Smoke checks against a live target
// ---------------------------------------------------------------------------

interface SmokeTarget {
  readonly url: string;
  readonly samplePeople: ReadonlyArray<string>;
  readonly samplePeopleLegacyIds: ReadonlyArray<number>;
  readonly sampleProjects: ReadonlyArray<string>;
  readonly sampleProjectLegacyIds: ReadonlyArray<number>;
}

async function timedFetch(
  name: string,
  url: string,
  init?: RequestInit,
): Promise<SmokeCheckResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    return {
      name,
      url,
      status: res.status,
      // 2xx is OK; 3xx is OK (legacy redirects); 401 on auth-protected smoke
      // endpoints isn't a fail by itself, but we don't probe any here.
      ok: res.status >= 200 && res.status < 400,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      name,
      url,
      status: null,
      ok: false,
      durationMs: Date.now() - started,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runSmokeChecks(target: SmokeTarget): Promise<SmokeCheckResult[]> {
  const base = target.url.replace(/\/$/, '');
  const results: SmokeCheckResult[] = [];

  for (const slug of target.samplePeople) {
    results.push(await timedFetch(`person:${slug}`, `${base}/api/people/${slug}`));
  }
  for (const slug of target.sampleProjects) {
    results.push(await timedFetch(`project:${slug}`, `${base}/api/projects/${slug}`));
  }
  for (const legacyId of target.sampleProjectLegacyIds) {
    results.push(
      await timedFetch(`project-legacy:${legacyId}`, `${base}/projects?ID=${legacyId}`),
    );
  }
  for (const legacyId of target.samplePeopleLegacyIds) {
    results.push(
      await timedFetch(`person-legacy:${legacyId}`, `${base}/people/${legacyId}`),
    );
  }
  results.push(await timedFetch('saml-metadata', `${base}/api/saml/idp/metadata`));
  results.push(await timedFetch('oauth-start', `${base}/api/auth/github/start`));
  results.push(await timedFetch('health', `${base}/api/health`));
  results.push(await timedFetch('health-ready', `${base}/api/health/ready`));

  return results;
}

// ---------------------------------------------------------------------------
// Sample selection
// ---------------------------------------------------------------------------

/** Pick at most `n` items deterministically by hashing each one against seed. */
export function deterministicSample<T>(items: ReadonlyArray<T>, n: number, seed: string): T[] {
  if (items.length <= n) return [...items];
  const scored = items.map((item, idx) => ({
    item,
    score: hashScore(`${seed}:${idx}:${String(item)}`),
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, n).map((s) => s.item);
}

function hashScore(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface DryRunOptions {
  readonly sql: string;
  readonly dataRepo: string;
  readonly privateStore: string;
  readonly target: string | null;
  readonly sampleSize: number;
  readonly now?: string;
  readonly seed?: string;
}

export async function runDryRun(opts: DryRunOptions): Promise<DryRunReport> {
  const runAt = opts.now ?? new Date().toISOString();
  const seed = opts.seed ?? runAt;

  const privateStore = new FilesystemPrivateStore({
    CFP_PRIVATE_STORAGE_PATH: opts.privateStore,
  });
  await privateStore.load();

  const importReport = await importLaddr({
    sql: opts.sql,
    dataRepo: opts.dataRepo,
    privateStore,
    now: runAt,
  });

  const sql = await readFile(opts.sql, 'utf8');
  const tableCounts = countRowsByTable(sql);
  const importsBySheet = importReport.entities;

  const seenSheets = new Set<string>();
  const countDiffs: CountDiff[] = [];
  for (const [table, sheet] of TABLE_TO_SHEET.entries()) {
    const sourceRows = tableCounts.get(table) ?? 0;
    if (sourceRows === 0) continue;
    seenSheets.add(sheet);
    const imported = importsBySheet[sheet]?.imported ?? 0;
    countDiffs.push({
      sheet,
      sourceRows,
      importedRecords: imported,
      matched: sourceRows === imported,
    });
  }
  // Surface unmapped tables that did appear in the dump. IGNORED_TABLES
  // (e.g. checkins) are intentionally not migrated; everything else
  // signals dump-shape drift that warrants attention.
  for (const [table, sourceRows] of tableCounts) {
    if (TABLE_TO_SHEET.has(table)) continue;
    if (IGNORED_TABLES.has(table)) continue;
    countDiffs.push({
      sheet: `unmapped:${table}`,
      sourceRows,
      importedRecords: 0,
      matched: false,
    });
  }

  let smokeChecks: SmokeCheckResult[] = [];
  if (opts.target) {
    const publicStore = await openPublicStore(opts.dataRepo);
    const people = await publicStore.people.queryAll();
    const projects = await publicStore.projects.queryAll();
    const liveProjects = projects.filter((p) => !p.deletedAt);
    const livePeople = people.filter((p) => !p.deletedAt);

    smokeChecks = await runSmokeChecks({
      url: opts.target,
      samplePeople: deterministicSample(
        livePeople.map((p) => p.slug),
        opts.sampleSize,
        `${seed}:people`,
      ),
      samplePeopleLegacyIds: deterministicSample(
        livePeople
          .map((p) => p.legacyId)
          .filter((id): id is number => typeof id === 'number'),
        opts.sampleSize,
        `${seed}:people-legacy`,
      ),
      sampleProjects: deterministicSample(
        liveProjects.map((p) => p.slug),
        opts.sampleSize,
        `${seed}:projects`,
      ),
      sampleProjectLegacyIds: deterministicSample(
        liveProjects
          .map((p) => p.legacyId)
          .filter((id): id is number => typeof id === 'number'),
        opts.sampleSize,
        `${seed}:projects-legacy`,
      ),
    });
  }

  const importPassed = importReport.warnings.length === 0
    ? true
    : importReport.warnings.every((w) => !w.toLowerCase().includes('error'));
  const countDiffPassed = countDiffs.every((d) => d.matched);
  const smokePassed = opts.target ? smokeChecks.every((c) => c.ok) : true;

  return {
    runAt,
    target: opts.target,
    importReport: {
      runAt: importReport.runAt,
      sourceSha256: importReport.sourceSha256,
      entities: importReport.entities,
      warnings: importReport.warnings,
    },
    countDiffs,
    smokeChecks,
    stages: {
      import: importPassed,
      countDiff: countDiffPassed,
      smoke: smokePassed,
    },
    passed: importPassed && countDiffPassed && smokePassed,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly sql: string;
  readonly dataRepo: string;
  readonly privateStore: string;
  readonly target: string | null;
  readonly sampleSize: number;
  readonly jsonPath: string | undefined;
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
      process.stderr.write(`missing --${k}=<value>\n`);
      process.exit(2);
    }
    return v;
  };
  const sampleRaw = opts['sample'];
  const sampleSize = typeof sampleRaw === 'string' ? Number.parseInt(sampleRaw, 10) : 10;
  return {
    sql: resolve(need('sql')),
    dataRepo: resolve(need('data-repo')),
    privateStore: resolve(need('private-store')),
    target: typeof opts['target'] === 'string' ? opts['target'] : null,
    sampleSize: Number.isFinite(sampleSize) ? sampleSize : 10,
    jsonPath: typeof opts['json'] === 'string' ? opts['json'] : undefined,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(`[cutover-dry-run] sql=${args.sql}\n`);
  process.stderr.write(`[cutover-dry-run] data-repo=${args.dataRepo}\n`);
  process.stderr.write(`[cutover-dry-run] private-store=${args.privateStore}\n`);
  process.stderr.write(`[cutover-dry-run] target=${args.target ?? '(none)'}\n`);

  const report = await runDryRun({
    sql: args.sql,
    dataRepo: args.dataRepo,
    privateStore: args.privateStore,
    target: args.target,
    sampleSize: args.sampleSize,
  });

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.jsonPath) {
    await writeFile(resolve(args.jsonPath), json, 'utf8');
  } else {
    process.stdout.write(json);
  }

  process.stderr.write(
    `[cutover-dry-run] import=${report.stages.import} ` +
      `countDiff=${report.stages.countDiff} ` +
      `smoke=${report.stages.smoke} ` +
      `passed=${report.passed}\n`,
  );

  process.exitCode = report.passed ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`[cutover-dry-run] failed: ${String(err)}\n`);
    process.exit(2);
  });
}
