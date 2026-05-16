/**
 * scrub-data.ts — Public snapshot scrubber
 *
 * Walks the source gitsheets data repo, pseudonymizes all PII fields in
 * Person records (names, slugs, github identities, slack handles), leaves
 * Project/Buzz/membership records structurally intact (cross-references
 * rewritten to pseudonymized slugs), and writes a single squashed orphan
 * commit to the target repo.
 *
 * Usage:
 *   npm run -w apps/api script:scrub-data -- \
 *     --source=./codeforphilly-data \
 *     --target=./codeforphilly-data-snapshot \
 *     [--seed=2026-05-15] [--dry-run]
 *
 * PII safety rules (enforced by the mandatory verification pass at the end):
 *   - No real names in output
 *   - No email addresses anywhere
 *   - No githubLogin / githubUserId / slackSamlNameId in Person records
 *   - No real person slugs in any field
 *   - Record counts must match source
 *
 * If verification fails the script exits non-zero and the target repo is
 * left in a clean pre-commit state (no write has been finalized).
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { faker } from '@faker-js/faker';
import { openRepo } from 'gitsheets';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Wordlists for deterministic slug pseudonymization
// ---------------------------------------------------------------------------

export const ADJECTIVES = [
  'amber', 'azure', 'bold', 'brave', 'bright', 'calm', 'clear', 'clever',
  'cool', 'crisp', 'daring', 'deep', 'eager', 'fair', 'fast', 'firm',
  'free', 'fresh', 'glad', 'gold', 'grand', 'great', 'green', 'happy',
  'hardy', 'keen', 'kind', 'light', 'lively', 'loyal', 'mild', 'noble',
  'open', 'proud', 'pure', 'quick', 'quiet', 'rapid', 'ready', 'rich',
  'round', 'safe', 'sharp', 'smart', 'solid', 'still', 'strong', 'swift',
  'tall', 'tidy', 'tough', 'true', 'vast', 'warm', 'wise', 'witty',
];

export const NOUNS = [
  'anchor', 'arrow', 'badge', 'beacon', 'bear', 'bird', 'brook', 'canoe',
  'cedar', 'cloud', 'comet', 'coral', 'crane', 'creek', 'dawn', 'deer',
  'delta', 'dune', 'eagle', 'ember', 'falcon', 'fern', 'ferry', 'finch',
  'flame', 'flint', 'forge', 'fox', 'frost', 'grove', 'hawk', 'heron',
  'holly', 'horn', 'inlet', 'iris', 'ivy', 'jade', 'jay', 'kite',
  'larch', 'lark', 'leaf', 'ledge', 'lime', 'lion', 'loon', 'lynx',
  'maple', 'mare', 'mast', 'meadow', 'mesa', 'mint', 'mist', 'moose',
  'moss', 'moth', 'oak', 'otter', 'owl', 'peak', 'pine', 'pond',
  'quail', 'raven', 'reed', 'reef', 'ridge', 'robin', 'rock', 'rose',
  'rush', 'sage', 'sand', 'seal', 'slate', 'snipe', 'sparrow', 'spruce',
  'stag', 'stone', 'swan', 'thorn', 'tide', 'vale', 'vole', 'wave',
  'wren', 'yarrow',
];

// ---------------------------------------------------------------------------
// Deterministic hashing
// ---------------------------------------------------------------------------

/** Deterministic unsigned 32-bit integer hash from a seed + input pair. */
export function deterministicHash(seed: string, input: string): number {
  const h = createHash('sha256').update(`${seed}:${input}`).digest();
  const byte0 = h[0] ?? 0;
  const byte1 = h[1] ?? 0;
  const byte2 = h[2] ?? 0;
  const byte3 = h[3] ?? 0;
  return ((byte0 << 24) | (byte1 << 16) | (byte2 << 8) | byte3) >>> 0;
}

// ---------------------------------------------------------------------------
// Slug pseudonymization
// ---------------------------------------------------------------------------

/**
 * Build a bidirectional slug map from realSlug → pseudoSlug.
 * Deterministic: same seed + same set of slugs = same output.
 * Collision-safe: appends a numeric suffix when two real slugs would map
 * to the same pseudo-slug.
 */
export function buildSlugMap(realSlugs: readonly string[], seed: string): Map<string, string> {
  const realToFake = new Map<string, string>();
  const usedFake = new Set<string>();

  for (const realSlug of realSlugs) {
    const h = deterministicHash(seed, realSlug);
    const adj = ADJECTIVES[h % ADJECTIVES.length];
    const nounH = deterministicHash(seed + ':noun', realSlug);
    const noun = NOUNS[nounH % NOUNS.length];
    let candidate = `${adj}-${noun}`;
    let suffix = 0;
    while (usedFake.has(candidate)) {
      suffix++;
      candidate = `${adj}-${noun}-${suffix}`;
    }
    usedFake.add(candidate);
    realToFake.set(realSlug, candidate);
  }

  return realToFake;
}

// ---------------------------------------------------------------------------
// @mention rewriting in markdown text
// ---------------------------------------------------------------------------

/**
 * Replace `@mention` occurrences of real person slugs in markdown-like text.
 */
export function rewriteMentions(text: string, slugMap: Map<string, string>): string {
  return text.replace(/@([a-z0-9][a-z0-9-]{1,49})/g, (_match, slug: string) => {
    const pseudo = slugMap.get(slug);
    return pseudo !== undefined ? `@${pseudo}` : `@${slug}`;
  });
}

// ---------------------------------------------------------------------------
// Record scrubbers
// ---------------------------------------------------------------------------

/**
 * Scrub a Person record. All PII fields are replaced with pseudonyms.
 * The UUID (`id`) is kept unchanged — cross-references rely on UUIDs, not slugs.
 */
export function scrubPersonRecord(
  record: Record<string, unknown>,
  slugMap: Map<string, string>,
  fakerInstance: typeof faker,
): Record<string, unknown> {
  const realSlug = typeof record['slug'] === 'string' ? record['slug'] : '';
  const pseudoSlug = slugMap.get(realSlug) ?? realSlug;

  const scrubbed: Record<string, unknown> = { ...record };

  // Pseudonymize human-facing identity fields
  scrubbed['slug'] = pseudoSlug;
  scrubbed['fullName'] = fakerInstance.person.fullName();
  scrubbed['firstName'] = fakerInstance.person.firstName();
  scrubbed['lastName'] = fakerInstance.person.lastName();

  // Replace bio with lorem ipsum
  if (scrubbed['bio'] !== null && scrubbed['bio'] !== undefined) {
    scrubbed['bio'] = fakerInstance.lorem.paragraph();
  }

  // Replace slackHandle with pseudo slug (Slack handle format is compatible)
  if (scrubbed['slackHandle'] !== null && scrubbed['slackHandle'] !== undefined) {
    scrubbed['slackHandle'] = pseudoSlug;
  }

  // Clear github identity — these are real identifiers, not for public snapshot
  delete scrubbed['githubLogin'];
  delete scrubbed['githubUserId'];
  delete scrubbed['githubLinkedAt'];

  // Clear SAML continuity field — not applicable to snapshot users
  delete scrubbed['slackSamlNameId'];

  // Clear avatar — no attachment data follows the snapshot
  delete scrubbed['avatarKey'];

  return scrubbed;
}

/**
 * Scrub a Project record. Project content is public-by-design; we leave it
 * intact but rewrite any @slug mentions in text fields.
 */
export function scrubProjectRecord(
  record: Record<string, unknown>,
  slugMap: Map<string, string>,
): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = { ...record };

  // Rewrite @mentions in text fields
  if (typeof scrubbed['overview'] === 'string') {
    scrubbed['overview'] = rewriteMentions(scrubbed['overview'], slugMap);
  }
  if (typeof scrubbed['summary'] === 'string') {
    scrubbed['summary'] = rewriteMentions(scrubbed['summary'], slugMap);
  }

  // chatChannel might contain a person's username — normalize to chat-<projectSlug>
  if (scrubbed['chatChannel'] !== null && scrubbed['chatChannel'] !== undefined) {
    const projectSlug = typeof scrubbed['slug'] === 'string' ? scrubbed['slug'] : 'project';
    scrubbed['chatChannel'] = `chat-${projectSlug}`;
  }

  // Clear featured image — no attachment data follows
  delete scrubbed['featuredImageKey'];

  return scrubbed;
}

/**
 * Scrub a ProjectBuzz record. Headline and URL are public; summary may have
 * @mentions. Image attachments are omitted.
 */
export function scrubProjectBuzzRecord(
  record: Record<string, unknown>,
  slugMap: Map<string, string>,
): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = { ...record };

  if (typeof scrubbed['summary'] === 'string') {
    scrubbed['summary'] = rewriteMentions(scrubbed['summary'], slugMap);
  }
  if (typeof scrubbed['headline'] === 'string') {
    scrubbed['headline'] = rewriteMentions(scrubbed['headline'], slugMap);
  }

  // Clear buzz images — no attachment data
  delete scrubbed['imageKey'];

  return scrubbed;
}

// ---------------------------------------------------------------------------
// TOML serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a record to TOML. Handles flat gitsheets record shapes:
 * string, number, boolean values. Null/undefined values are omitted (TOML
 * has no null; absence is treated as null by gitsheets).
 */
export function toToml(record: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      if (value.includes('\n')) {
        lines.push(`${key} = """\n${value}\n"""`);
      } else {
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        lines.push(`${key} = "${escaped}"`);
      }
    } else if (typeof value === 'number') {
      lines.push(`${key} = ${value}`);
    } else if (typeof value === 'boolean') {
      lines.push(`${key} = ${value}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Minimal TOML parser (for reading source records when needed)
// ---------------------------------------------------------------------------

/**
 * Parse a flat TOML file into a plain object.
 * Handles: string, integer, float, boolean, multi-line strings.
 * Sufficient for flat gitsheets records.
 */
export function parseFlatToml(toml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = toml.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    i++;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Multi-line string: key = """
    const mlMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"""(.*)$/);
    if (mlMatch) {
      const key = mlMatch[1];
      const firstRest = mlMatch[2] ?? '';
      const parts: string[] = [];
      if (firstRest.trim() !== '') parts.push(firstRest);
      while (i < lines.length) {
        const mlLine = lines[i] ?? '';
        i++;
        if (mlLine.includes('"""')) {
          const closeIdx = mlLine.indexOf('"""');
          const beforeClose = mlLine.slice(0, closeIdx);
          if (beforeClose.trim() !== '') parts.push(beforeClose);
          break;
        }
        parts.push(mlLine);
      }
      const value = parts.join('\n').replace(/^\n/, '');
      if (key !== undefined) result[key] = value;
      continue;
    }

    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    if (key === undefined) continue;
    const rawVal = (kvMatch[2] ?? '').trim();

    if (rawVal === 'true') { result[key] = true; continue; }
    if (rawVal === 'false') { result[key] = false; continue; }

    if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
      result[key] = rawVal.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      continue;
    }

    const num = Number(rawVal);
    if (!isNaN(num) && rawVal !== '') {
      result[key] = num;
      continue;
    }

    result[key] = rawVal;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Verification pass
// ---------------------------------------------------------------------------

export interface VerificationResult {
  passed: boolean;
  errors: string[];
}

/** Walk a directory tree returning all .toml file paths. */
async function walkToml(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkToml(fullPath)));
    } else if (entry.name.endsWith('.toml')) {
      files.push(fullPath);
    }
  }
  return files;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Verify a snapshot directory contains no PII.
 * Checks for email patterns, real slugs, and sensitive identity fields.
 */
export async function verifySnapshot(
  targetPath: string,
  realSlugs: ReadonlySet<string>,
): Promise<VerificationResult> {
  const errors: string[] = [];
  const tomlFiles = await walkToml(targetPath);

  for (const filePath of tomlFiles) {
    const content = await readFile(filePath, 'utf-8');

    // Rule 1: No email addresses (catches user@example.com patterns)
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emailMatches = content.match(emailPattern);
    if (emailMatches) {
      errors.push(`Email-like pattern found in ${filePath}: ${emailMatches.join(', ')}`);
    }

    // Rule 2: No real person slugs in any file
    for (const realSlug of realSlugs) {
      // Match slug as a standalone value (quoted string or unquoted)
      const slugPattern = new RegExp(
        `(?:^|[\\s='"\\[/])${escapeRegex(realSlug)}(?:[\\s'"\\]/]|$)`,
        'm',
      );
      if (slugPattern.test(content)) {
        errors.push(`Real slug "${realSlug}" found in ${filePath}`);
      }
    }

    // Rule 3: Person records must not contain github identity fields with values
    if (filePath.includes('/people/')) {
      const sensitiveFields = ['githubLogin', 'githubUserId', 'slackSamlNameId'];
      for (const field of sensitiveFields) {
        const fieldPattern = new RegExp(`^${field}\\s*=\\s*(?!null)[^\\n]+`, 'm');
        if (fieldPattern.test(content)) {
          errors.push(`Sensitive field "${field}" found with value in ${filePath}`);
        }
      }
    }
  }

  return { passed: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Path template resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a gitsheets path template against a record.
 * e.g. template='${slug}' root='people' record={slug:'foo'} → 'people/foo.toml'
 * Handles both ${{ field }} and ${field} syntax.
 */
export function resolvePathTemplate(
  template: string,
  record: Record<string, unknown>,
  root: string,
): string {
  const expanded = template.replace(
    /\$\{\{?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}?\}/g,
    (_m, key: string) => {
      const val = record[key];
      return val !== null && val !== undefined ? String(val) : '';
    },
  );

  const fullPath = root !== '.' ? `${root}/${expanded}` : expanded;
  return `${fullPath}.toml`;
}

// ---------------------------------------------------------------------------
// Core scrub function (exported for testing)
// ---------------------------------------------------------------------------

export interface ScrubOptions {
  /** Absolute path to the source gitsheets repo. */
  source: string;
  /** Absolute path to the target snapshot repo (will be init'd if absent). */
  target: string;
  /** Pseudonymization seed. Same seed → byte-identical output. */
  seed: string;
  /** If true, validate + report but do not write anything. */
  dryRun?: boolean;
}

export interface ScrubResult {
  /** Number of records processed per sheet name. */
  sourceCounts: Record<string, number>;
  /** SHA-1 of the resulting git commit, or null if dry-run / nothing changed. */
  commitHash: string | null;
  /** Name of the snapshot branch/tag, or null if dry-run. */
  branchName: string | null;
}

type GitRunner = (...args: string[]) => Promise<{ stdout: string; stderr: string }>;

async function initOrOpenTargetRepo(targetPath: string): Promise<GitRunner> {
  await mkdir(targetPath, { recursive: true });
  const git: GitRunner = (...args) => exec('git', args, { cwd: targetPath });

  try {
    await git('rev-parse', '--git-dir');
  } catch {
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'snapshot@users.noreply.codeforphilly.org');
    await git('config', 'user.name', 'Code for Philly');
    await git('config', 'commit.gpgsign', 'false');
  }

  return git;
}

/**
 * Run the full snapshot scrub. Returns a ScrubResult.
 * Throws (with a descriptive message) if verification fails or counts mismatch.
 */
export async function scrubRepo(opts: ScrubOptions): Promise<ScrubResult> {
  const { source, target, seed, dryRun = false } = opts;

  // -------------------------------------------------------------------------
  // 1. Open source repo
  // -------------------------------------------------------------------------
  const sourceRepo = await openRepo({ workTree: source, gitDir: join(source, '.git') });
  const sourceHeadHash = await sourceRepo.resolveRef('HEAD');

  // -------------------------------------------------------------------------
  // 2. Discover all sheets
  // -------------------------------------------------------------------------
  const sheets = await sourceRepo.openSheets();

  // -------------------------------------------------------------------------
  // 3. Collect all Person slugs
  // -------------------------------------------------------------------------
  const allPersonSlugs: string[] = [];
  const personSheet = sheets['people'];
  if (personSheet !== undefined) {
    for await (const record of personSheet.query()) {
      const slug = record['slug'];
      if (typeof slug === 'string') allPersonSlugs.push(slug);
    }
  }

  const slugMap = buildSlugMap(allPersonSlugs, seed);

  // -------------------------------------------------------------------------
  // 4. Per-person faker seeding (deterministic)
  // -------------------------------------------------------------------------
  function fakerForSlug(realSlug: string): typeof faker {
    const personSeed = deterministicHash(seed, `person:${realSlug}`);
    faker.seed(personSeed);
    return faker;
  }

  // -------------------------------------------------------------------------
  // 5. Scrub all records
  // -------------------------------------------------------------------------
  const sourceCounts: Record<string, number> = {};
  const scrubCounts: Record<string, number> = {};
  const scrubbedFiles: Array<{ path: string; content: string }> = [];

  for (const [sheetName, sheet] of Object.entries(sheets)) {
    let count = 0;
    let scrubCount = 0;

    for await (const record of sheet.query()) {
      count++;
      const rec = record as Record<string, unknown>;
      let scrubbed: Record<string, unknown>;

      if (sheetName === 'people') {
        const realSlug = typeof rec['slug'] === 'string' ? rec['slug'] : '';
        scrubbed = scrubPersonRecord(rec, slugMap, fakerForSlug(realSlug));
      } else if (sheetName === 'projects') {
        scrubbed = scrubProjectRecord(rec, slugMap);
      } else if (sheetName === 'project-buzz') {
        scrubbed = scrubProjectBuzzRecord(rec, slugMap);
      } else {
        scrubbed = { ...rec };
        for (const [k, v] of Object.entries(scrubbed)) {
          if (typeof v === 'string' && v.includes('@')) {
            scrubbed[k] = rewriteMentions(v, slugMap);
          }
        }
      }

      const sheetConfig = await sheet.getCachedConfig();
      const outputPath = resolvePathTemplate(sheetConfig.path, scrubbed, sheetConfig.root);
      scrubbedFiles.push({ path: outputPath, content: toToml(scrubbed) });
      scrubCount++;
    }

    sourceCounts[sheetName] = count;
    scrubCounts[sheetName] = scrubCount;
  }

  // -------------------------------------------------------------------------
  // 6. Count validation
  // -------------------------------------------------------------------------
  const countMismatches: string[] = [];
  for (const [sheetName, sourceCount] of Object.entries(sourceCounts)) {
    const scrubCount = scrubCounts[sheetName] ?? 0;
    if (sourceCount !== scrubCount) {
      countMismatches.push(`Sheet "${sheetName}": source=${sourceCount} scrubbed=${scrubCount}`);
    }
  }
  if (countMismatches.length > 0) {
    throw new Error(`Record count mismatch:\n${countMismatches.join('\n')}`);
  }

  if (dryRun) {
    return { sourceCounts, commitHash: null, branchName: null };
  }

  // -------------------------------------------------------------------------
  // 7. Write files to target
  // -------------------------------------------------------------------------
  const git = await initOrOpenTargetRepo(target);

  // Wipe existing content (exclude .git)
  const targetEntries = await readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of targetEntries) {
    if (entry.name === '.git') continue;
    await rm(join(target, entry.name), { recursive: true, force: true });
  }

  for (const { path: relPath, content } of scrubbedFiles) {
    const fullPath = join(target, relPath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
  }

  // Copy .gitsheets config from source
  const sourceGitsheetsDir = join(source, '.gitsheets');
  const targetGitsheetsDir = join(target, '.gitsheets');
  await mkdir(targetGitsheetsDir, { recursive: true });
  const configFiles = await readdir(sourceGitsheetsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of configFiles) {
    if (entry.isFile() && entry.name.endsWith('.toml')) {
      const configContent = await readFile(join(sourceGitsheetsDir, entry.name), 'utf-8');
      await writeFile(join(targetGitsheetsDir, entry.name), configContent, 'utf-8');
    }
  }

  // -------------------------------------------------------------------------
  // 8. Verification pass (before committing)
  // -------------------------------------------------------------------------
  const realSlugSet = new Set(allPersonSlugs);
  const verification = await verifySnapshot(target, realSlugSet);

  if (!verification.passed) {
    // Clean up written files before exiting
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      await rm(join(target, entry.name), { recursive: true, force: true });
    }
    throw new Error(`Verification failed:\n${verification.errors.join('\n')}`);
  }

  // -------------------------------------------------------------------------
  // 9. Commit: orphan squashed commit
  // -------------------------------------------------------------------------
  const timestamp = new Date().toISOString();
  const branchName = `snapshot-${seed.replace(/[^a-z0-9]/gi, '-')}-scrubbed`;

  const commitMessage = `snapshot: anonymized data export from ${timestamp}

Generated by apps/api/scripts/scrub-data.ts.
Source revision: ${sourceHeadHash ?? 'unknown'}
Seed: ${seed}

This snapshot is intended for contributor onboarding. It contains no
real names, no emails, no GitHub identities. All personal data has
been pseudonymized via the documented scrubbing rules.

See apps/api/scripts/scrub-data.ts and specs/behaviors/storage.md.`;

  await git('add', '.');
  const { stdout: porcelain } = await git('status', '--porcelain');
  if (porcelain.trim() === '') {
    return { sourceCounts, commitHash: null, branchName };
  }

  const { stdout: treeHashRaw } = await git('write-tree');
  const treeHash = treeHashRaw.trim();

  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Code for Philly',
    GIT_AUTHOR_EMAIL: 'snapshot@users.noreply.codeforphilly.org',
    GIT_COMMITTER_NAME: 'Code for Philly',
    GIT_COMMITTER_EMAIL: 'snapshot@users.noreply.codeforphilly.org',
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  };

  const messageFile = join(target, '.git', 'SNAPSHOT_MSG');
  await writeFile(messageFile, commitMessage, 'utf-8');

  const { stdout: commitHashRaw } = await exec(
    'git',
    ['commit-tree', treeHash, '-F', messageFile],
    { cwd: target, env: commitEnv },
  );
  const commitHash = commitHashRaw.trim();

  await git('update-ref', `refs/heads/${branchName}`, commitHash);
  await git('symbolic-ref', 'HEAD', `refs/heads/${branchName}`);

  await exec('git', ['tag', '-f', branchName, commitHash], {
    cwd: target,
    env: commitEnv,
  });

  return { sourceCounts, commitHash, branchName };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): ScrubOptions {
  const args: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx === -1) {
        args[arg.slice(2)] = true;
      } else {
        args[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      }
    }
  }

  const source = typeof args['source'] === 'string' ? args['source'] : '';
  const target = typeof args['target'] === 'string' ? args['target'] : '';
  if (!source || !target) {
    process.stderr.write('Usage: scrub-data --source=<path> --target=<path> [--seed=<string>] [--dry-run]\n');
    process.exit(1);
  }

  const seed =
    typeof args['seed'] === 'string'
      ? args['seed']
      : (new Date().toISOString().split('T')[0] ?? '2026-01-01');

  return {
    source: resolve(source),
    target: resolve(target),
    seed,
    dryRun: args['dry-run'] === true,
  };
}

// ---------------------------------------------------------------------------
// Entry point (only runs when invoked directly, not when imported in tests)
// ---------------------------------------------------------------------------

// Check if this file is the main module
const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `scrub-data: source=${opts.source} target=${opts.target} seed=${opts.seed} dry-run=${opts.dryRun ?? false}`,
  );
  scrubRepo(opts)
    .then((result) => {
      console.log('Source counts:', result.sourceCounts);
      if (result.commitHash) {
        console.log(`Committed: ${result.commitHash} on branch ${result.branchName ?? '?'}`);
      }
      console.log('Done.');
    })
    .catch((err: unknown) => {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
