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
 * Records are written through gitsheets sheet upserts in the target, so the
 * snapshot gets each sheet's canonical serialization, path template and
 * storage format (markdown for blog-posts). Attachments are copied, except
 * on `people` (avatars are PII). A record that can't render its path — or
 * would land on another record's path — fails the run instead of being
 * silently collapsed.
 *
 * If verification fails the script exits non-zero and no target ref moves
 * (the staged objects are left unreferenced).
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { faker } from '@faker-js/faker';
import { getFormat, openRepo, RECORD_PATH_KEY, type BlobHandle, type UpsertResult } from 'gitsheets';

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

  // Clear avatar — person attachments (photos of real people) never follow
  // the snapshot; see SHEETS_WITHOUT_ATTACHMENTS
  delete scrubbed['avatarKey'];

  return scrubbed;
}

/**
 * Scrub a Project record. Project content is public-by-design; we leave it
 * intact (attachments and `featuredImageKey` included) but rewrite any
 * @slug mentions in text fields.
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

  return scrubbed;
}

/**
 * Scrub a ProjectBuzz record. Headline and URL are public; summary may have
 * @mentions. Image attachments follow the record, so `imageKey` stays.
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

  return scrubbed;
}

// ---------------------------------------------------------------------------
// Verification pass
// ---------------------------------------------------------------------------

export interface VerificationResult {
  passed: boolean;
  errors: string[];
}

/** A serialized record file: repo-relative (or absolute) path + text. */
export interface SnapshotFile {
  readonly path: string;
  readonly content: string;
}

/** Record file extensions: TOML records and markdown (content-typed) records. */
const RECORD_FILE = /\.(toml|md)$/;

/** Walk a directory tree returning all record file paths (.toml / .md). */
async function walkRecordFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkRecordFiles(fullPath)));
    } else if (RECORD_FILE.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Verify serialized record files contain no PII.
 * Checks for email patterns, real slugs, and sensitive identity fields.
 */
export function verifySnapshotFiles(
  files: Iterable<SnapshotFile>,
  realSlugs: ReadonlySet<string>,
): VerificationResult {
  const errors: string[] = [];
  const slugPatterns = [...realSlugs].map((realSlug) => ({
    realSlug,
    // Match slug as a standalone value (quoted string or unquoted)
    pattern: new RegExp(`(?:^|[\\s='"\\[/])${escapeRegex(realSlug)}(?:[\\s'"\\]/]|$)`, 'm'),
  }));

  for (const { path: filePath, content } of files) {
    // Rule 1: No email addresses (catches user@example.com patterns)
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emailMatches = content.match(emailPattern);
    if (emailMatches) {
      errors.push(`Email-like pattern found in ${filePath}: ${emailMatches.join(', ')}`);
    }

    // Rule 2: No real person slugs in any file
    for (const { realSlug, pattern } of slugPatterns) {
      if (pattern.test(content)) {
        errors.push(`Real slug "${realSlug}" found in ${filePath}`);
      }
    }

    // Rule 3: Person records must not contain github identity fields with values
    if (`/${filePath}`.includes('/people/')) {
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

/** Verify a snapshot directory's record files (.toml / .md) contain no PII. */
export async function verifySnapshot(
  targetPath: string,
  realSlugs: ReadonlySet<string>,
): Promise<VerificationResult> {
  const files: SnapshotFile[] = [];
  for (const filePath of await walkRecordFiles(targetPath)) {
    files.push({ path: filePath, content: await readFile(filePath, 'utf-8') });
  }
  return verifySnapshotFiles(files, realSlugs);
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

const SNAPSHOT_AUTHOR = { name: 'Code for Philly', email: 'snapshot@users.noreply.codeforphilly.org' };

/**
 * Sheets whose attachments never follow a record into the snapshot. Person
 * attachments are avatars — photos of real people — so they are PII.
 */
const SHEETS_WITHOUT_ATTACHMENTS: ReadonlySet<string> = new Set(['people']);

interface ScrubbedRecord {
  readonly sheetName: string;
  readonly record: Record<string, unknown>;
  /** Source attachments to copy, or null when the record has none / they're dropped. */
  readonly attachments: Record<string, BlobHandle> | null;
}

async function initOrOpenTargetRepo(targetPath: string): Promise<GitRunner> {
  await mkdir(targetPath, { recursive: true });
  const git: GitRunner = (...args) => exec('git', args, { cwd: targetPath });

  try {
    await git('rev-parse', '--git-dir');
  } catch {
    await git('init', '-b', 'main');
    await git('config', 'user.email', SNAPSHOT_AUTHOR.email);
    await git('config', 'user.name', SNAPSHOT_AUTHOR.name);
    await git('config', 'commit.gpgsign', 'false');
  }

  return git;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Write a parentless commit holding only the source's `.gitsheets/` configs,
 * for the record transaction to build on.
 *
 * Stays on raw git plumbing (hash-object / mktree / commit-tree): gitsheets
 * 2.7 has no public API for writing non-record files (`tx.writeFile` is
 * internal) or for orphan commits. Swap once upstream exposes them.
 */
async function writeConfigRootCommit(
  targetPath: string,
  configs: ReadonlyArray<{ name: string; content: Buffer }>,
): Promise<string> {
  // A throwaway index builds the nested `.gitsheets/` tree (configs plus
  // `contracts/<host>/<path>.toml`) without touching any real index.
  const indexFile = join(await mkdtemp(join(tmpdir(), 'cfp-scrub-index-')), 'index');
  const indexEnv = { ...process.env, GIT_INDEX_FILE: indexFile };
  for (const { name, content } of configs) {
    const hash = await new Promise<string>((resolvePromise, reject) => {
      const child = execFile(
        'git',
        ['hash-object', '-w', '--stdin'],
        { cwd: targetPath },
        (err, stdout) => (err ? reject(err) : resolvePromise(stdout.trim())),
      );
      child.stdin?.end(content);
    });
    await exec('git', ['update-index', '--add', '--cacheinfo', `100644,${hash},.gitsheets/${name}`], {
      cwd: targetPath,
      env: indexEnv,
    });
  }
  const rootTree = (await exec('git', ['write-tree'], { cwd: targetPath, env: indexEnv })).stdout.trim();
  await rm(dirname(indexFile), { recursive: true, force: true });
  const { stdout } = await exec('git', ['commit-tree', rootTree, '-m', 'scrub-data: sheet configs'], {
    cwd: targetPath,
    env: { ...process.env, ...gitIdentityEnv(new Date().toISOString()) },
  });
  return stdout.trim();
}

function gitIdentityEnv(timestamp: string): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: SNAPSHOT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: SNAPSHOT_AUTHOR.email,
    GIT_COMMITTER_NAME: SNAPSHOT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: SNAPSHOT_AUTHOR.email,
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  };
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
  const sourceRepo = await openRepo({ gitDir: source });
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
  const scrubbedRecords: ScrubbedRecord[] = [];

  for (const [sheetName, sheet] of Object.entries(sheets)) {
    let count = 0;

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

      // Look attachments up by the record's source path (as read), not a
      // re-render of its template.
      const sourcePath = (record as Record<PropertyKey, unknown>)[RECORD_PATH_KEY];
      const attachments = SHEETS_WITHOUT_ATTACHMENTS.has(sheetName)
        ? null
        : await sheet.getAttachments(typeof sourcePath === 'string' ? sourcePath : record);
      scrubbedRecords.push({ sheetName, record: scrubbed, attachments });
    }

    sourceCounts[sheetName] = count;
  }

  if (dryRun) {
    return { sourceCounts, commitHash: null, branchName: null };
  }

  // -------------------------------------------------------------------------
  // 6. Stage the snapshot tree through gitsheets: a transaction on top of a
  //    config-only root commit upserts every scrubbed record (canonical
  //    serialization, path templates, content-typed formats) and copies
  //    attachments. The transaction commits on a bare hash parent, so no ref
  //    moves; its tree is re-committed as the orphan snapshot in step 9.
  // -------------------------------------------------------------------------
  const git = await initOrOpenTargetRepo(target);
  const targetGitDir = (await git('rev-parse', '--absolute-git-dir')).stdout.trim();
  const targetRepo = await openRepo({ gitDir: targetGitDir });

  // Everything under the source's `.gitsheets/`: sheet configs plus the
  // vendored schema contracts (`contracts/…`) that configs may declare.
  const sourceRef = sourceHeadHash ?? 'HEAD';
  const configPaths = (
    await exec('git', ['ls-tree', '-r', '--name-only', sourceRef, '.gitsheets/'], { cwd: source })
  ).stdout
    .split('\n')
    .filter((p) => p.length > 0);
  const configs = await Promise.all(
    configPaths.map(async (path) => ({
      name: path.slice('.gitsheets/'.length),
      content: await streamToBuffer(await sourceRepo.readBlobStream(sourceRef, path)),
    })),
  );
  const configRoot = await writeConfigRootCommit(target, configs);

  const writtenFiles: SnapshotFile[] = [];
  const scrubCounts: Record<string, number> = {};
  const staged = await targetRepo.transact(
    {
      parent: configRoot,
      message: 'scrub-data: staged snapshot tree (re-committed as an orphan)',
      author: SNAPSHOT_AUTHOR,
    },
    async (tx) => {
      const pathsBySheet = new Map<string, Map<string, unknown>>();
      for (const { sheetName, record, attachments } of scrubbedRecords) {
        const sheet = tx.sheet(sheetName);
        let result: UpsertResult;
        try {
          result = await sheet.upsert(record, { allowMissingBody: true });
        } catch (err) {
          throw new Error(
            `Sheet "${sheetName}": cannot write record ${describeRecord(record)}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }

        let paths = pathsBySheet.get(sheetName);
        if (!paths) pathsBySheet.set(sheetName, (paths = new Map()));
        if (paths.has(result.path)) {
          throw new Error(
            `Sheet "${sheetName}": records ${describeRecord(paths.get(result.path))} and ${describeRecord(record)} both render to path "${result.path}"`,
          );
        }
        paths.set(result.path, record);
        scrubCounts[sheetName] = (scrubCounts[sheetName] ?? 0) + 1;
        // UpsertResult.path is sheet-relative and extensionless; verification
        // wants the repo path (e.g. people/<slug>.toml, blog-posts/<slug>.md).
        const config = await sheet.getCachedConfig();
        const repoPath = `${config.root === '.' ? '' : `${config.root}/`}${result.path}${getFormat(config.format.type).extension}`;
        writtenFiles.push({ path: repoPath, content: (await result.blob.read()).toString('utf-8') });

        if (attachments !== null && Object.keys(attachments).length > 0) {
          const bytes: Record<string, Buffer> = {};
          for (const [name, handle] of Object.entries(attachments)) bytes[name] = await handle.read();
          await sheet.setAttachments(record, bytes);
        }
      }
    },
  );
  const treeHash = staged.treeHash;
  if (treeHash === null) throw new Error('scrub-data: internal: staging transaction produced no tree');

  // -------------------------------------------------------------------------
  // 7. Count validation — a record that collapsed onto another's path, or
  //    failed to write, shows up here.
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

  // -------------------------------------------------------------------------
  // 8. Verification pass (before any ref moves)
  // -------------------------------------------------------------------------
  const verification = verifySnapshotFiles(writtenFiles, new Set(allPersonSlugs));
  if (!verification.passed) {
    throw new Error(`Verification failed:\n${verification.errors.join('\n')}`);
  }

  // -------------------------------------------------------------------------
  // 9. Commit: orphan squashed commit of the staged tree
  //
  //    Stays on raw git (commit-tree / update-ref / symbolic-ref / tag):
  //    gitsheets 2.7 can't write a parentless commit. The snapshot workflow
  //    pushes HEAD and tags it, so HEAD must point at the new branch.
  // -------------------------------------------------------------------------
  const timestamp = new Date().toISOString();
  const branchName = `snapshot-${seed.replace(/[^a-z0-9]/gi, '-')}-scrubbed`;

  const currentTree = await git('rev-parse', '--verify', '--quiet', 'HEAD^{tree}')
    .then((r) => r.stdout.trim())
    .catch(() => null);
  if (currentTree === treeHash) {
    return { sourceCounts, commitHash: null, branchName };
  }

  const commitMessage = `snapshot: anonymized data export from ${timestamp}

Generated by apps/api/scripts/scrub-data.ts.
Source revision: ${sourceHeadHash ?? 'unknown'}
Seed: ${seed}

This snapshot is intended for contributor onboarding. It contains no
real names, no emails, no GitHub identities. All personal data has
been pseudonymized via the documented scrubbing rules.

See apps/api/scripts/scrub-data.ts and specs/behaviors/storage.md.`;

  const commitEnv = { ...process.env, ...gitIdentityEnv(timestamp) };
  const { stdout: commitHashRaw } = await exec('git', ['commit-tree', treeHash, '-m', commitMessage], {
    cwd: target,
    env: commitEnv,
  });
  const commitHash = commitHashRaw.trim();

  await git('update-ref', `refs/heads/${branchName}`, commitHash);
  await git('symbolic-ref', 'HEAD', `refs/heads/${branchName}`);
  await exec('git', ['tag', '-f', branchName, commitHash], { cwd: target, env: commitEnv });

  // Bring a non-bare target's working tree in line with the new HEAD.
  if ((await git('rev-parse', '--is-bare-repository')).stdout.trim() !== 'true') {
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      await rm(join(target, entry.name), { recursive: true, force: true });
    }
    await git('reset', '--quiet', '--hard', 'HEAD');
  }

  return { sourceCounts, commitHash, branchName };
}

function describeRecord(record: unknown): string {
  const r = (record ?? {}) as Record<string, unknown>;
  const key = r['id'] ?? r['slug'];
  return typeof key === 'string' ? `"${key}"` : JSON.stringify(record);
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
