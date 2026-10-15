/**
 * Migration: child records reference path-keyed parents by slug
 * (plans/slug-references.md, specs/principles.md → "A record holds
 * everything its path needs").
 *
 * Rewrites every record of the six sheets whose paths are keyed by a
 * parent's handle to the v2 contract shape:
 *
 *   project-memberships   projectId, personId → projectSlug, personSlug
 *   project-updates       projectId           → projectSlug
 *   project-buzz          projectId           → projectSlug
 *   help-wanted-roles     projectId           → projectSlug
 *   help-wanted-interest  personId            → personSlug
 *   event-rsvps           eventId, personId   → year, eventSlug, personSlug
 *
 * Each slug field comes from the record's on-disk value (writes have always
 * stored it, since the path renders from it), falling back to resolving the
 * dropped id through the parent sheet. An RSVP's `year` falls back to its
 * event's partition year (the `YYYY` of `startsAt`, the rule the events path
 * uses). An RSVP's own `projectId` (the "coming to work on" answer) is not a
 * path reference and stays.
 *
 * Before writing anything it checks every slug reference resolves to a
 * record in its parent sheet (and every RSVP's year matches its event); if
 * any doesn't, it lists them and exits without writing. All rewrites land in
 * one commit on `--branch`. Re-running is a no-op.
 *
 * It does not adopt the v2 contracts — do that first with
 * `gitsheets contracts adopt` and the sheet configs' `implements`; the
 * migration refuses to run against a branch whose six sheets declare
 * anything other than the contract version this build publishes.
 *
 * Usage:
 *   npm run -w apps/api script:migrate-slug-references -- \
 *     --data-repo=/path/to/codeforphilly-data.git --branch=fixture [--dry-run]
 *
 *   --data-repo  Bare clone of the data repo. Falls back to $CFP_DATA_REPO_PATH.
 *   --branch     Branch to migrate (required). Must exist locally.
 *   --dry-run    Validate and report without committing.
 */
import { resolve } from 'node:path';

import { SHEET_REFERENCES, contractName, type ContractSheet } from '@cfp/shared';
import { openRepo, RECORD_PATH_KEY, type BlobHandle, type Repository } from 'gitsheets';
import type { z } from 'zod';

import { PUBLIC_SHEET_SCHEMAS } from '../../src/store/public.js';

export const MIGRATED_SHEETS = [
  'project-memberships',
  'project-updates',
  'project-buzz',
  'help-wanted-roles',
  'help-wanted-interest',
  'event-rsvps',
] as const satisfies readonly ContractSheet[];
type MigratedSheet = (typeof MIGRATED_SHEETS)[number];

/** The id fields each sheet drops, keyed to the parent sheet they named. */
const DROPPED_IDS: Record<MigratedSheet, Record<string, ParentSheet>> = {
  'project-memberships': { projectId: 'projects', personId: 'people' },
  'project-updates': { projectId: 'projects' },
  'project-buzz': { projectId: 'projects' },
  'help-wanted-roles': { projectId: 'projects' },
  'help-wanted-interest': { personId: 'people' },
  'event-rsvps': { eventId: 'events', personId: 'people' },
};

/** The slug field that replaces each dropped id. */
const SLUG_FIELD_FOR_ID: Record<string, string> = {
  projectId: 'projectSlug',
  personId: 'personSlug',
  eventId: 'eventSlug',
};

type ParentSheet = 'projects' | 'people' | 'events';
const PARENT_SHEETS: readonly ParentSheet[] = ['projects', 'people', 'events'];

const AUTHOR = { name: 'Code for Philly API', email: 'api@users.noreply.codeforphilly.org' };

type Rec = Record<string, unknown>;

interface Parents {
  readonly slugById: Record<ParentSheet, Map<string, string>>;
  readonly slugs: Record<ParentSheet, Set<string>>;
  /** event slug → its partition year */
  readonly eventYearBySlug: Map<string, string>;
}

export interface MigrateOptions {
  readonly dataRepo: string;
  readonly branch: string;
  readonly dryRun?: boolean;
  readonly log?: (msg: string) => void;
}

export interface MigrateResult {
  /** Records read per sheet. */
  readonly scanned: Record<string, number>;
  /** Records rewritten per sheet (0 everywhere on a re-run). */
  readonly rewritten: Record<string, number>;
  /** The migration commit, or null for a dry run or a no-op. */
  readonly commitHash: string | null;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[],
  ) {
    super(`${message}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'MigrationError';
  }
}

/** The `YYYY` partition an event's records live under — `partitionYear` in event.write.ts. */
function partitionYear(startsAt: string): string {
  return startsAt.slice(0, 4);
}

function stripAnnotations(record: Rec): Rec {
  return Object.fromEntries(Object.entries(record));
}

function describe(sheet: string, record: Rec): string {
  const path = (record as Record<PropertyKey, unknown>)[RECORD_PATH_KEY];
  return `${sheet}/${typeof path === 'string' ? path : String(record['id'] ?? '?')}`;
}

interface TxSheet {
  query(): AsyncIterable<Rec>;
  upsert(record: Rec): Promise<unknown>;
  delete(record: Rec | string): Promise<void>;
  pathForRecord(record: Rec): Promise<string>;
  getAttachments(record: Rec | string): Promise<Record<string, BlobHandle> | null>;
  setAttachments(record: Rec, attachments: Record<string, BlobHandle>): Promise<void>;
}

async function readAll(sheet: TxSheet): Promise<Rec[]> {
  const out: Rec[] = [];
  for await (const r of sheet.query()) out.push(r);
  return out;
}

/** Every sheet the migration rewrites must declare the contract this build publishes. */
async function checkDeclaredContracts(repo: Repository, ref: string): Promise<void> {
  const problems: string[] = [];
  for (const sheet of MIGRATED_SHEETS) {
    const expected = contractName(sheet);
    let config: string;
    try {
      const stream = await repo.readBlobStream(ref, `.gitsheets/${sheet}.toml`);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
      config = Buffer.concat(chunks).toString('utf8');
    } catch {
      problems.push(`.gitsheets/${sheet}.toml is missing`);
      continue;
    }
    const declared = /^implements\s*=\s*\[(.*)\]/m.exec(config)?.[1] ?? '';
    const names = [...declared.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    if (!names.includes(expected)) {
      problems.push(`${sheet} declares [${names.join(', ')}], not ${expected}`);
    }
  }
  if (problems.length > 0) {
    throw new MigrationError(
      'Adopt the v2 contracts before migrating (gitsheets contracts adopt + implements)',
      problems,
    );
  }
}

async function readParents(sheetOf: (name: string) => TxSheet): Promise<Parents> {
  const slugById = { projects: new Map(), people: new Map(), events: new Map() } as Parents['slugById'];
  const slugs = { projects: new Set(), people: new Set(), events: new Set() } as Parents['slugs'];
  const eventYearBySlug = new Map<string, string>();
  for (const parent of PARENT_SHEETS) {
    for (const r of await readAll(sheetOf(parent))) {
      const id = r['id'];
      const slug = r['slug'];
      if (typeof slug !== 'string') continue;
      slugs[parent].add(slug);
      if (typeof id === 'string') slugById[parent].set(id, slug);
      if (parent === 'events' && typeof r['startsAt'] === 'string') {
        eventYearBySlug.set(slug, partitionYear(r['startsAt']));
      }
    }
  }
  return { slugById, slugs, eventYearBySlug };
}

/**
 * The record in the new shape, plus any reason it can't be written. Pure:
 * reads `parents`, mutates nothing.
 */
function migrateRecord(
  sheet: MigratedSheet,
  record: Rec,
  parents: Parents,
): { next: Rec; problems: string[] } {
  const next = stripAnnotations(record);
  const problems: string[] = [];
  const where = describe(sheet, record);

  // Fill each slug field from the dropped id when the record lacks it; keep
  // what the id resolves to, as a hint for a stale stored slug.
  const resolvedFromId = new Map<string, string>();
  for (const [idField, parent] of Object.entries(DROPPED_IDS[sheet])) {
    const slugField = SLUG_FIELD_FOR_ID[idField]!;
    const id = next[idField];
    const resolved = typeof id === 'string' ? parents.slugById[parent].get(id) : undefined;
    if (resolved !== undefined) resolvedFromId.set(slugField, resolved);
    if ((typeof next[slugField] !== 'string' || next[slugField] === '') && resolved !== undefined) {
      next[slugField] = resolved;
    }
    delete next[idField];
  }

  // Every declared slug reference must resolve to a record in its parent sheet.
  for (const ref of SHEET_REFERENCES.filter((r) => r.sheet === sheet)) {
    const target = ref.target.sheet as ParentSheet;
    const value = next[ref.field];
    if (typeof value !== 'string' || value === '') {
      problems.push(`${where}: no ${ref.field}, and no id that resolves in ${target}`);
    } else if (!parents.slugs[target].has(value)) {
      const hint = resolvedFromId.get(ref.field);
      problems.push(
        `${where}: ${ref.field}='${value}' does not resolve in ${target}` +
          (hint !== undefined && hint !== value ? ` (its id resolves to '${hint}')` : ''),
      );
    }
  }

  if (sheet === 'event-rsvps') {
    const eventSlug = next['eventSlug'];
    const eventYear = typeof eventSlug === 'string' ? parents.eventYearBySlug.get(eventSlug) : undefined;
    if (typeof next['year'] !== 'string' || next['year'] === '') {
      if (eventYear !== undefined) next['year'] = eventYear;
    } else if (eventYear !== undefined && next['year'] !== eventYear) {
      problems.push(
        `${where}: year='${String(next['year'])}' but event '${String(eventSlug)}' is partitioned under ${eventYear}`,
      );
    }
  }

  const schema = PUBLIC_SHEET_SCHEMAS[sheet] as unknown as z.ZodType;
  const parsed = schema.safeParse(next);
  if (!parsed.success && problems.length === 0) {
    problems.push(
      `${where}: not a valid ${sheet} record after migration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return { next, problems };
}

function sameRecord(a: Rec, b: Rec): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

export async function migrateSlugReferences(opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? ((): void => {});
  const repo = await openRepo({ gitDir: opts.dataRepo });
  const ref = `refs/heads/${opts.branch}`;
  if ((await repo.resolveRef(ref)) === null) {
    throw new Error(`branch '${opts.branch}' not found in ${opts.dataRepo}`);
  }
  await checkDeclaredContracts(repo, ref);

  const scanned: Record<string, number> = {};
  const rewritten: Record<string, number> = {};

  const result = await repo.transact(
    {
      parent: ref,
      branch: ref,
      message:
        'migrate: child records reference parents by slug\n\n' +
        'Rewrites project-memberships, project-updates, project-buzz,\n' +
        'help-wanted-roles, help-wanted-interest and event-rsvps to their v2\n' +
        'contract shape: slug references replace parent ids\n' +
        '(codeforphilly-ng plans/slug-references.md).\n',
      author: AUTHOR,
      trailers: { Action: 'migrate.slug-references' },
    },
    async (tx) => {
      const sheetOf = (name: string): TxSheet => tx.sheet(name) as unknown as TxSheet;
      const parents = await readParents(sheetOf);

      // Plan every rewrite first; write nothing unless all of it is sound.
      const plan: Array<{ sheet: MigratedSheet; record: Rec; next: Rec }> = [];
      const problems: string[] = [];
      for (const sheet of MIGRATED_SHEETS) {
        const records = await readAll(sheetOf(sheet));
        scanned[sheet] = records.length;
        rewritten[sheet] = 0;
        for (const record of records) {
          const { next, problems: recordProblems } = migrateRecord(sheet, record, parents);
          problems.push(...recordProblems);
          if (!sameRecord(stripAnnotations(record), next)) plan.push({ sheet, record, next });
        }
      }
      if (problems.length > 0) {
        throw new MigrationError(`${problems.length} reference(s) do not resolve; nothing written`, problems);
      }
      if (opts.dryRun) {
        for (const { sheet } of plan) rewritten[sheet] = (rewritten[sheet] ?? 0) + 1;
        return;
      }

      for (const { sheet, record, next } of plan) {
        const s = sheetOf(sheet);
        const oldPath = (record as Record<PropertyKey, unknown>)[RECORD_PATH_KEY];
        const newPath = await s.pathForRecord(next);
        if (typeof oldPath === 'string' && oldPath !== newPath) {
          // A fallback slug moved the record: carry its attachments along.
          const attachments = await s.getAttachments(oldPath);
          await s.delete(oldPath);
          await s.upsert(next);
          if (attachments && Object.keys(attachments).length > 0) await s.setAttachments(next, attachments);
        } else {
          await s.upsert(next);
        }
        rewritten[sheet] = (rewritten[sheet] ?? 0) + 1;
      }
      log(`[migrate] rewrote ${plan.length} record(s)`);
    },
  );

  return { scanned, rewritten, commitHash: opts.dryRun ? null : result.commitHash };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): MigrateOptions {
  const opts: Record<string, string | true> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) opts[a.slice(2)] = true;
    else opts[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const dataRepo =
    typeof opts['data-repo'] === 'string' && opts['data-repo'] !== ''
      ? opts['data-repo']
      : process.env['CFP_DATA_REPO_PATH'];
  if (!dataRepo) {
    process.stderr.write('missing --data-repo=<path> (or set CFP_DATA_REPO_PATH)\n');
    process.exit(2);
  }
  const branch = opts['branch'];
  if (typeof branch !== 'string' || branch === '') {
    process.stderr.write('missing --branch=<name>\n');
    process.exit(2);
  }
  return {
    dataRepo: resolve(dataRepo),
    branch,
    dryRun: opts['dry-run'] === true,
    log: (msg) => console.log(msg),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[migrate] ${args.dataRepo} ${args.branch}${args.dryRun ? ' (dry run)' : ''}`);
  const result = await migrateSlugReferences(args);
  for (const sheet of MIGRATED_SHEETS) {
    console.log(`  ${sheet.padEnd(22)} scanned ${result.scanned[sheet] ?? 0}, rewritten ${result.rewritten[sheet] ?? 0}`);
  }
  if (args.dryRun) console.log('(dry run: nothing written)');
  else if (result.commitHash) console.log(`commit: ${result.commitHash} on ${args.branch}`);
  else console.log('(no changes: already migrated)');
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
