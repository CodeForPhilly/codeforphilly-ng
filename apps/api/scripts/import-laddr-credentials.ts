/**
 * import-laddr-credentials.ts — One-shot importer for legacy laddr
 * email + password-hash records into the private store's JSONL files.
 *
 * The public `import-laddr.ts` script deliberately handles only public
 * data; private fields (email, password hashes) are out of scope there
 * because the public laddr JSON API doesn't expose them.
 *
 * This script consumes a CSV exported from the laddr MySQL database
 * with columns `Username,Email,Password` (one row per active user),
 * joins each row against the in-repo Person records by slug, and
 * emits two JSONL files:
 *
 *   profiles.jsonl          — one PrivateProfile per resolved user
 *   legacy-passwords.jsonl  — one LegacyPasswordCredential per row with
 *                             a non-empty Password
 *
 * Both files are full-replace artifacts: the script always writes the
 * complete set, not a diff. Re-running it after some users have
 * already rehashed their credential (via login or password-reset)
 * would clobber those argon2id hashes with the original SHA-1/bcrypt
 * — so this is meant for the cutover seed, not mid-life maintenance.
 *
 * Output files are local. Deployment to the runtime backend
 * (FilesystemPrivateStore PVC for sandbox / S3-compat bucket including
 * GCS for prod) is a separate step — see docs/operations/cutover.md.
 *
 * Usage:
 *   npm run -w apps/api script:import-laddr-credentials -- \
 *     --input .scratch/legacy-logins-export.csv \
 *     --data-repo /path/to/codeforphilly-data \
 *     --output-dir .scratch/private-import \
 *     [--dry-run] [--verbose]
 *
 * Defaults:
 *   --input        .scratch/legacy-logins-export.csv
 *   --data-repo    $CFP_DATA_REPO_PATH (required if flag not given)
 *   --output-dir   .scratch/private-import
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type {
  LegacyPasswordCredential,
  Person,
  PrivateProfile,
} from '@cfp/shared/schemas';
import {
  LegacyPasswordCredentialSchema,
  PrivateProfileSchema,
} from '@cfp/shared/schemas';
import { openPublicStore } from '../src/store/public.js';

interface CliArgs {
  readonly input: string;
  readonly dataRepo: string;
  readonly outputDir: string;
  readonly dryRun: boolean;
  readonly verbose: boolean;
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

  const input =
    typeof opts['input'] === 'string' && opts['input'] !== ''
      ? (opts['input'] as string)
      : '.scratch/legacy-logins-export.csv';
  const outputDir =
    typeof opts['output-dir'] === 'string' && opts['output-dir'] !== ''
      ? (opts['output-dir'] as string)
      : '.scratch/private-import';

  return {
    input: resolve(input),
    dataRepo: resolve(dataRepoRaw),
    outputDir: resolve(outputDir),
    dryRun: opts['dry-run'] === true,
    verbose: opts['verbose'] === true,
  };
}

interface CsvRow {
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly lineNumber: number;
}

/**
 * Minimal RFC-4180-ish CSV parser sufficient for our export shape.
 * Handles double-quoted fields with embedded commas and "" escapes.
 * Does not handle multi-line quoted fields (the laddr export has none —
 * Username, Email, Password are all single-line atoms).
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cur);
        cur = '';
      } else if (ch === '"' && cur.length === 0) {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

async function readCsv(path: string): Promise<readonly CsvRow[]> {
  const raw = await readFile(path, 'utf8');
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0] ?? '').map((h) => h.trim());
  const idxUsername = header.indexOf('Username');
  const idxEmail = header.indexOf('Email');
  const idxPassword = header.indexOf('Password');
  if (idxUsername === -1 || idxEmail === -1 || idxPassword === -1) {
    throw new Error(
      `CSV header missing required columns Username/Email/Password — got: ${header.join(',')}`,
    );
  }

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    const cells = parseCsvLine(line);
    rows.push({
      username: (cells[idxUsername] ?? '').trim(),
      email: (cells[idxEmail] ?? '').trim(),
      password: cells[idxPassword] ?? '',
      lineNumber: i + 1,
    });
  }
  return rows;
}

interface ImportReport {
  readonly runAt: string;
  readonly inputRows: number;
  readonly profilesWritten: number;
  readonly credentialsWritten: number;
  readonly skippedNoUsername: number;
  readonly skippedNoEmail: number;
  readonly skippedInvalidEmail: number;
  readonly skippedNoPersonMatch: number;
  readonly skippedDeletedPerson: number;
  readonly skippedDuplicatePersonId: number;
  readonly warnings: readonly string[];
  readonly profilesPath: string | null;
  readonly credentialsPath: string | null;
}

async function run(args: CliArgs): Promise<ImportReport> {
  const runAt = new Date().toISOString();
  const warnings: string[] = [];

  console.log(`[import-creds] input=${args.input}`);
  console.log(`[import-creds] data-repo=${args.dataRepo}`);
  console.log(`[import-creds] output-dir=${args.outputDir}`);
  console.log(`[import-creds] dry-run=${args.dryRun}`);

  if (!existsSync(args.input)) {
    throw new Error(`Input file not found: ${args.input}`);
  }

  const { store: publicStore } = await openPublicStore(args.dataRepo);
  const people = await publicStore.people.queryAll();
  const bySlug = new Map<string, Person>();
  for (const p of people) bySlug.set(p.slug.toLowerCase(), p);
  console.log(`[import-creds] loaded ${people.length} Person records from data repo`);

  const rows = await readCsv(args.input);
  console.log(`[import-creds] parsed ${rows.length} CSV rows`);

  const profiles: PrivateProfile[] = [];
  const credentials: LegacyPasswordCredential[] = [];
  const seenPersonIds = new Set<string>();
  let skippedNoUsername = 0;
  let skippedNoEmail = 0;
  let skippedInvalidEmail = 0;
  let skippedNoPersonMatch = 0;
  let skippedDeletedPerson = 0;
  let skippedDuplicatePersonId = 0;

  for (const row of rows) {
    if (!row.username) {
      skippedNoUsername += 1;
      continue;
    }
    if (!row.email) {
      skippedNoEmail += 1;
      if (args.verbose) warnings.push(`line ${row.lineNumber}: no email for username "${row.username}"`);
      continue;
    }
    const person = bySlug.get(row.username.toLowerCase());
    if (!person) {
      skippedNoPersonMatch += 1;
      if (args.verbose) warnings.push(`line ${row.lineNumber}: no Person for username "${row.username}"`);
      continue;
    }
    if (person.deletedAt) {
      skippedDeletedPerson += 1;
      continue;
    }
    if (seenPersonIds.has(person.id)) {
      skippedDuplicatePersonId += 1;
      warnings.push(
        `line ${row.lineNumber}: duplicate username "${row.username}" → personId ${person.id}; keeping first occurrence`,
      );
      continue;
    }

    // Validate the email shape via the schema's parse — laddr's DB can
    // hold malformed addresses (e.g. trailing whitespace already stripped
    // by us, but also literal junk). Schema rejection → skip + warn.
    let profile: PrivateProfile;
    try {
      profile = PrivateProfileSchema.parse({
        personId: person.id,
        email: row.email,
        emailRefreshedAt: runAt,
        newsletter: null,
        updatedAt: runAt,
      });
    } catch (err) {
      skippedInvalidEmail += 1;
      if (args.verbose) {
        warnings.push(
          `line ${row.lineNumber}: invalid email "${row.email}" for "${row.username}" — ${(err as Error).message}`,
        );
      }
      continue;
    }
    profiles.push(profile);
    seenPersonIds.add(person.id);

    // Empty password column → user has an email-only account (rare,
    // some laddr users were created without a password). Emit the
    // profile but no credential — they'll have to use the password-reset
    // flow if they ever want one.
    if (row.password.length === 0) continue;

    try {
      const cred = LegacyPasswordCredentialSchema.parse({
        personId: person.id,
        passwordHash: row.password,
        importedAt: runAt,
        lastUsedAt: null,
      });
      credentials.push(cred);
    } catch (err) {
      warnings.push(
        `line ${row.lineNumber}: invalid passwordHash for "${row.username}" — ${(err as Error).message}`,
      );
    }
  }

  const profilesLines = profiles.map((p) => JSON.stringify(p)).join('\n');
  const credentialsLines = credentials.map((c) => JSON.stringify(c)).join('\n');

  let profilesPath: string | null = null;
  let credentialsPath: string | null = null;
  if (!args.dryRun) {
    await mkdir(args.outputDir, { recursive: true });
    profilesPath = join(args.outputDir, 'profiles.jsonl');
    credentialsPath = join(args.outputDir, 'legacy-passwords.jsonl');
    await writeFile(profilesPath, profilesLines ? profilesLines + '\n' : '');
    await writeFile(credentialsPath, credentialsLines ? credentialsLines + '\n' : '');
  }

  return {
    runAt,
    inputRows: rows.length,
    profilesWritten: profiles.length,
    credentialsWritten: credentials.length,
    skippedNoUsername,
    skippedNoEmail,
    skippedInvalidEmail,
    skippedNoPersonMatch,
    skippedDeletedPerson,
    skippedDuplicatePersonId,
    warnings,
    profilesPath,
    credentialsPath,
  };
}

function printReport(report: ImportReport): void {
  console.log(`\n=== import-creds report ===`);
  console.log(`runAt:                       ${report.runAt}`);
  console.log(`input rows:                  ${report.inputRows}`);
  console.log(`profiles written:            ${report.profilesWritten}`);
  console.log(`credentials written:         ${report.credentialsWritten}`);
  console.log(`skipped (no username):       ${report.skippedNoUsername}`);
  console.log(`skipped (no email):          ${report.skippedNoEmail}`);
  console.log(`skipped (invalid email):     ${report.skippedInvalidEmail}`);
  console.log(`skipped (no person match):   ${report.skippedNoPersonMatch}`);
  console.log(`skipped (deleted person):    ${report.skippedDeletedPerson}`);
  console.log(`skipped (duplicate person):  ${report.skippedDuplicatePersonId}`);
  console.log(`warnings:                    ${report.warnings.length}`);
  for (const w of report.warnings.slice(0, 25)) console.log(`  ${w}`);
  if (report.warnings.length > 25) {
    console.log(`  ... (${report.warnings.length - 25} more — re-run with --verbose to see all)`);
  }
  if (report.profilesPath) console.log(`profiles:      ${report.profilesPath}`);
  if (report.credentialsPath) console.log(`credentials:   ${report.credentialsPath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await run(args);
  printReport(report);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  main().catch((err: unknown) => {
    console.error('[import-creds] failed:', err);
    process.exit(1);
  });
}
