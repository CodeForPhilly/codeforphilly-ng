/**
 * Orchestrator: laddr (live JSON) → v1 snapshot commit on `legacy-import`.
 *
 * Each run produces one new commit whose tree fully replaces the previous
 * one. Consecutive commits diff cleanly to show what changed upstream on
 * the live laddr site between runs.
 *
 * Branch model:
 *   - On first run, `legacy-import` is created from the `empty` branch (which
 *     carries only `.gitsheets/` configs, no records).
 *   - On subsequent runs, the importer resets a working ref to the current
 *     `legacy-import` HEAD, removes every importer-owned directory, writes
 *     fresh files, and commits.
 *   - Records use `<sheet>/<legacyId>.toml` paths (composite for memberships
 *     and tag-assignments) so re-runs overwrite stable filenames. The
 *     legacy-import branch is parallel history — the runtime spec's slug-
 *     based path templates apply once data is merged into `main`, which is
 *     an operator step outside this importer's scope.
 *
 * Author identity on every commit: the pseudonymous Code for Philly API
 * user (see plans/laddr-import-via-json.md). The agent's git config is
 * never used.
 *
 * Side effects:
 *   - Writes/removes files in the data repo's working tree
 *   - Creates one commit on the local `legacy-import` branch
 *   - Does NOT push to origin (operator's call)
 *
 * Private-store side: out of scope for this importer. The JSON endpoints
 * expose only public fields; private data (emails, password hashes,
 * newsletter prefs) will be imported separately on a future plan.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

import {
  PersonSchema,
  ProjectBuzzSchema,
  ProjectMembershipSchema,
  ProjectSchema,
  ProjectUpdateSchema,
  TagAssignmentSchema,
  TagSchema,
} from '@cfp/shared/schemas';
import type {
  Person,
  Project,
  ProjectBuzz,
  ProjectMembership,
  ProjectUpdate,
  Tag,
  TagAssignment,
} from '@cfp/shared/schemas';

import {
  fetchAllPages,
  RawPersonSchema,
  RawProjectBuzzSchema,
  RawProjectSchema,
  RawProjectUpdateSchema,
  RawTagSchema,
  type FetchOptions,
  type RawPerson,
  type RawProject,
  type RawProjectBuzz,
  type RawProjectUpdate,
  type RawTag,
} from './json-fetcher.js';
import {
  newExistingIds,
  newIdMaps,
  translateBuzz,
  translateMembership,
  translatePerson,
  translateProject,
  translateTag,
  translateTagAssignment,
  translateUpdate,
  type ExistingIds,
  type IdMaps,
  type TranslateCtx,
  type Warnings,
} from './translators.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Source host (e.g. `codeforphilly.org`). */
  readonly sourceHost: string;
  /** Path to a local clone of the `codeforphilly-data` repo. */
  readonly dataRepo: string;
  /** Branch to write the snapshot on; default `legacy-import`. */
  readonly branch?: string;
  /** Ref to fall back to as the parent when `branch` doesn't exist yet; default `origin/empty`. */
  readonly initialParent?: string;
  /** If true, fetch + translate + report but do not write to the repo. */
  readonly dryRun?: boolean;
  /** If true, write files + stage but do not commit. */
  readonly noCommit?: boolean;
  /** Truncate each fetched resource to N rows (for dev loops). */
  readonly limit?: number;
  /** Increase logging verbosity. */
  readonly verbose?: boolean;
  /** Override the wall clock; deterministic in tests. */
  readonly now?: string;
  /** Override `fetch` for testing. */
  readonly fetchImpl?: typeof fetch;
  /** Polite per-page delay. */
  readonly delayMs?: number;
  /** Per-page count. */
  readonly pageSize?: number;
}

export interface EntityCounts {
  /** Records validated and queued for write. */
  imported: number;
  /** Records dropped at translation (unresolved FKs, invalid slugs, etc.). */
  skipped: number;
  /** Records that threw at Zod validation. */
  errors: number;
}

export interface ImportReport {
  readonly runAt: string;
  readonly sourceHost: string;
  readonly branch: string;
  readonly counts: Record<string, EntityCounts>;
  readonly warnings: string[];
  /** Commit hash produced, or null in `--dry-run` / `--no-commit` / no-changes. */
  readonly commitHash: string | null;
  /** True when the working tree after staging matches HEAD (so no commit was made). */
  readonly noChanges: boolean;
}

const AUTHOR_NAME = 'Code for Philly API';
const AUTHOR_EMAIL = 'api@users.noreply.codeforphilly.org';

const IMPORTER_OWNED_DIRS = [
  'people',
  'projects',
  'tags',
  'project-memberships',
  'project-updates',
  'project-buzz',
  'tag-assignments',
] as const;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function importLaddrFromJson(opts: ImportOptions): Promise<ImportReport> {
  const runAt = opts.now ?? new Date().toISOString();
  const branch = opts.branch ?? 'legacy-import';
  const initialParent = opts.initialParent ?? 'origin/empty';
  const log = opts.verbose ? (msg: string) => console.log(msg) : (_msg: string) => {};

  const warningsList: string[] = [];
  const warnings: Warnings = {
    push: (w) => {
      warningsList.push(w);
      if (opts.verbose) console.warn(w);
    },
  };

  const counts: Record<string, EntityCounts> = {
    tags: blank(),
    people: blank(),
    projects: blank(),
    'project-memberships': blank(),
    'project-updates': blank(),
    'project-buzz': blank(),
    'tag-assignments': blank(),
  };

  const idMaps = newIdMaps();

  // -------------------------------------------------------------------------
  // 0. Pre-pass — read existing UUIDs from the target branch so re-runs
  //    are idempotent. Without this, every run mints fresh UUIDs and
  //    every commit diffs against the last even when nothing changed
  //    upstream.
  // -------------------------------------------------------------------------
  const existingIds = opts.dryRun
    ? newExistingIds()
    : await collectExistingIds(opts.dataRepo, branch, initialParent);
  const ctx: TranslateCtx = { idMaps, warnings, now: runAt, existingIds };

  // -------------------------------------------------------------------------
  // 1. Fetch + translate everything in FK order. We accumulate in memory —
  //    laddr's full snapshot is ~30k rows total which fits comfortably.
  // -------------------------------------------------------------------------
  const fetchOpts: FetchOptions = {
    host: opts.sourceHost,
    userAgent: 'cfp-importer/dev',
    pageSize: opts.pageSize ?? 200,
    limit: opts.limit,
    delayMs: opts.delayMs ?? 250,
    fetchImpl: opts.fetchImpl,
    log,
  };

  log(`[import] fetching tags from ${opts.sourceHost}`);
  const tags: Tag[] = [];
  for await (const row of fetchAllPages<RawTag>(
    '/tags',
    RawTagSchema,
    {},
    fetchOpts,
  )) {
    const translated = translateTag(row, ctx);
    if (translated === null) {
      counts.tags!.skipped++;
      continue;
    }
    const parsed = parseOrSkip('tags', () => TagSchema.parse(translated), counts, warnings);
    if (parsed) {
      tags.push(parsed);
      counts.tags!.imported++;
    }
  }

  log(`[import] fetching people from ${opts.sourceHost} (this is the large one)`);
  const people: Person[] = [];
  const tagAssignments: TagAssignment[] = [];
  const tagAssignmentLegacyTuples: Array<{ tagLegacyId: number; taggableLegacyId: number; taggableType: 'project' | 'person' }> = [];
  for await (const row of fetchAllPages<RawPerson>(
    '/people',
    RawPersonSchema,
    { include: 'Tags' },
    fetchOpts,
  )) {
    let translated: Person;
    try {
      translated = translatePerson(row, ctx);
    } catch (err) {
      counts.people!.skipped++;
      warnings.push(`[people] legacyId=${row.ID} translator threw: ${describe(err)}`);
      continue;
    }
    const parsed = parseOrSkip('people', () => PersonSchema.parse(translated), counts, warnings);
    if (parsed) {
      people.push(parsed);
      counts.people!.imported++;
      for (const rawTag of row.Tags ?? []) {
        const ta = translateTagAssignment(rawTag, row.ID, 'person', ctx);
        if (ta === null) {
          counts['tag-assignments']!.skipped++;
          continue;
        }
        const parsedTa = parseOrSkip(
          'tag-assignments',
          () => TagAssignmentSchema.parse(ta.assignment),
          counts,
          warnings,
        );
        if (parsedTa) {
          tagAssignments.push(parsedTa);
          tagAssignmentLegacyTuples.push({
            tagLegacyId: ta.tagLegacyId,
            taggableLegacyId: ta.taggableLegacyId,
            taggableType: 'person',
          });
          counts['tag-assignments']!.imported++;
        }
      }
    }
  }

  log(`[import] fetching projects from ${opts.sourceHost} (with Tags + Memberships)`);
  const projects: Project[] = [];
  const memberships: Array<{
    record: ProjectMembership;
    legacyIds: { projectLegacyId: number; personLegacyId: number };
  }> = [];
  for await (const row of fetchAllPages<RawProject>(
    '/projects',
    RawProjectSchema,
    { include: 'Tags,Memberships' },
    fetchOpts,
  )) {
    let translated: Project;
    try {
      translated = translateProject(row, ctx);
    } catch (err) {
      counts.projects!.skipped++;
      warnings.push(`[projects] legacyId=${row.ID} translator threw: ${describe(err)}`);
      continue;
    }
    const parsed = parseOrSkip(
      'projects',
      () => ProjectSchema.parse(translated),
      counts,
      warnings,
    );
    if (parsed) {
      projects.push(parsed);
      counts.projects!.imported++;

      for (const rawTag of row.Tags ?? []) {
        const ta = translateTagAssignment(rawTag, row.ID, 'project', ctx);
        if (ta === null) {
          counts['tag-assignments']!.skipped++;
          continue;
        }
        const parsedTa = parseOrSkip(
          'tag-assignments',
          () => TagAssignmentSchema.parse(ta.assignment),
          counts,
          warnings,
        );
        if (parsedTa) {
          tagAssignments.push(parsedTa);
          tagAssignmentLegacyTuples.push({
            tagLegacyId: ta.tagLegacyId,
            taggableLegacyId: ta.taggableLegacyId,
            taggableType: 'project',
          });
          counts['tag-assignments']!.imported++;
        }
      }

      const maintainerLegacyId =
        typeof row.MaintainerID === 'number' ? row.MaintainerID : null;
      for (const rawMem of row.Memberships ?? []) {
        const m = translateMembership(rawMem, maintainerLegacyId, ctx);
        if (m === null) {
          counts['project-memberships']!.skipped++;
          continue;
        }
        const parsedMem = parseOrSkip(
          'project-memberships',
          () => ProjectMembershipSchema.parse(m.membership),
          counts,
          warnings,
        );
        if (parsedMem) {
          memberships.push({ record: parsedMem, legacyIds: m.legacyIds });
          counts['project-memberships']!.imported++;
        }
      }
    }
  }

  log(`[import] fetching project-updates from ${opts.sourceHost}`);
  const updates: Array<{ record: ProjectUpdate; projectLegacyId: number }> = [];
  for await (const row of fetchAllPages<RawProjectUpdate>(
    '/project-updates',
    RawProjectUpdateSchema,
    {},
    fetchOpts,
  )) {
    const u = translateUpdate(row, ctx);
    if (u === null) {
      counts['project-updates']!.skipped++;
      continue;
    }
    const parsedU = parseOrSkip(
      'project-updates',
      () => ProjectUpdateSchema.parse(u.update),
      counts,
      warnings,
    );
    if (parsedU) {
      updates.push({ record: parsedU, projectLegacyId: u.projectLegacyId });
      counts['project-updates']!.imported++;
    }
  }

  log(`[import] fetching project-buzz from ${opts.sourceHost}`);
  const buzz: Array<{ record: ProjectBuzz; projectLegacyId: number }> = [];
  for await (const row of fetchAllPages<RawProjectBuzz>(
    '/project-buzz',
    RawProjectBuzzSchema,
    {},
    fetchOpts,
  )) {
    const b = translateBuzz(row, ctx);
    if (b === null) {
      counts['project-buzz']!.skipped++;
      continue;
    }
    const parsedB = parseOrSkip(
      'project-buzz',
      () => ProjectBuzzSchema.parse(b.buzz),
      counts,
      warnings,
    );
    if (parsedB) {
      buzz.push({ record: parsedB, projectLegacyId: b.projectLegacyId });
      counts['project-buzz']!.imported++;
    }
  }

  // -------------------------------------------------------------------------
  // 2. Dry-run: report and return without touching the repo.
  // -------------------------------------------------------------------------
  if (opts.dryRun) {
    return {
      runAt,
      sourceHost: opts.sourceHost,
      branch,
      counts,
      warnings: warningsList,
      commitHash: null,
      noChanges: false,
    };
  }

  // -------------------------------------------------------------------------
  // 3. Stage tree in the data repo's working dir.
  //    - Reset branch ref to current legacy-import HEAD (or initialParent if
  //      the branch doesn't exist locally yet).
  //    - Wipe every importer-owned directory.
  //    - Write fresh files.
  //    - `git add -A <owned-dirs>` and create commit.
  // -------------------------------------------------------------------------
  const repo = resolve(opts.dataRepo);
  await ensureGitRepo(repo);
  const parent = await ensureBranch(repo, branch, initialParent);
  await checkoutBranch(repo, branch, parent);
  await wipeOwnedDirectories(repo);

  const filesWritten = await writeAllRecords(repo, {
    tags,
    people,
    projects,
    memberships,
    updates,
    buzz,
    tagAssignments,
    tagAssignmentLegacyTuples,
    idMaps,
    warnings,
  });

  log(`[import] wrote ${filesWritten} files`);

  // -------------------------------------------------------------------------
  // 4. Stage and check for changes.
  // -------------------------------------------------------------------------
  for (const dir of IMPORTER_OWNED_DIRS) {
    await git(repo, 'add', '-A', '--', dir);
  }

  if (opts.noCommit) {
    return {
      runAt,
      sourceHost: opts.sourceHost,
      branch,
      counts,
      warnings: warningsList,
      commitHash: null,
      noChanges: false,
    };
  }

  // Compare the tree we built to the parent's tree — when nothing changed
  // upstream, we want to exit cleanly without creating an empty commit.
  const { stdout: porcelain } = await git(repo, 'status', '--porcelain');
  if (porcelain.trim() === '') {
    log('[import] no changes from parent commit — nothing to commit');
    return {
      runAt,
      sourceHost: opts.sourceHost,
      branch,
      counts,
      warnings: warningsList,
      commitHash: null,
      noChanges: true,
    };
  }

  const commitHash = await createImportCommit(repo, {
    branch,
    runAt,
    sourceHost: opts.sourceHost,
    counts,
  });

  return {
    runAt,
    sourceHost: opts.sourceHost,
    branch,
    counts,
    warnings: warningsList,
    commitHash,
    noChanges: false,
  };
}

// ---------------------------------------------------------------------------
// Filesystem writers
// ---------------------------------------------------------------------------

interface WriteBundle {
  readonly tags: readonly Tag[];
  readonly people: readonly Person[];
  readonly projects: readonly Project[];
  readonly memberships: readonly {
    record: ProjectMembership;
    legacyIds: { projectLegacyId: number; personLegacyId: number };
  }[];
  readonly updates: readonly {
    record: ProjectUpdate;
    projectLegacyId: number;
  }[];
  readonly buzz: readonly {
    record: ProjectBuzz;
    projectLegacyId: number;
  }[];
  readonly tagAssignments: readonly TagAssignment[];
  readonly tagAssignmentLegacyTuples: readonly {
    tagLegacyId: number;
    taggableLegacyId: number;
    taggableType: 'project' | 'person';
  }[];
  readonly idMaps: IdMaps;
  readonly warnings: Warnings;
}

async function writeAllRecords(repo: string, b: WriteBundle): Promise<number> {
  let count = 0;

  // people/<legacyId>.toml
  for (const r of b.people) {
    if (r.legacyId === undefined) continue;
    await writeRecord(repo, ['people', `${r.legacyId}.toml`], r);
    count++;
  }
  // projects/<legacyId>.toml
  for (const r of b.projects) {
    if (r.legacyId === undefined) continue;
    await writeRecord(repo, ['projects', `${r.legacyId}.toml`], r);
    count++;
  }
  // tags/<legacyId>.toml
  for (const r of b.tags) {
    if (r.legacyId === undefined) continue;
    await writeRecord(repo, ['tags', `${r.legacyId}.toml`], r);
    count++;
  }
  // project-memberships/<projectLegacyId>-<personLegacyId>.toml
  for (const { record, legacyIds } of b.memberships) {
    await writeRecord(
      repo,
      ['project-memberships', `${legacyIds.projectLegacyId}-${legacyIds.personLegacyId}.toml`],
      record,
    );
    count++;
  }
  // project-updates/<legacyId>.toml
  for (const { record } of b.updates) {
    if (record.legacyId === undefined) continue;
    await writeRecord(repo, ['project-updates', `${record.legacyId}.toml`], record);
    count++;
  }
  // project-buzz/<legacyId>.toml
  for (const { record } of b.buzz) {
    if (record.legacyId === undefined) continue;
    await writeRecord(repo, ['project-buzz', `${record.legacyId}.toml`], record);
    count++;
  }
  // tag-assignments/<tagLegacyId>-<taggableType>-<taggableLegacyId>.toml
  for (let i = 0; i < b.tagAssignments.length; i++) {
    const record = b.tagAssignments[i]!;
    const legacy = b.tagAssignmentLegacyTuples[i]!;
    await writeRecord(
      repo,
      [
        'tag-assignments',
        `${legacy.tagLegacyId}-${legacy.taggableType}-${legacy.taggableLegacyId}.toml`,
      ],
      record,
    );
    count++;
  }

  return count;
}

async function writeRecord(
  repo: string,
  pathParts: readonly string[],
  record: Record<string, unknown>,
): Promise<void> {
  const full = join(repo, ...pathParts);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, toToml(record), 'utf8');
}

// ---------------------------------------------------------------------------
// TOML serialization (flat records; same shape as scripts/scrub-data.ts).
// Records are written with keys in a stable alphabetical order so consecutive
// snapshots produce stable diffs even if the in-memory object key order
// drifts.
// ---------------------------------------------------------------------------

export function toToml(record: Record<string, unknown>): string {
  const keys = Object.keys(record).sort();
  const lines: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      if (value.includes('\n')) {
        // Use TOML's basic-multiline-string form; escape the rare embedded
        // triple-quote sequence and any backslashes.
        const escaped = value.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""');
        lines.push(`${key} = """\n${escaped}\n"""`);
      } else {
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        lines.push(`${key} = "${escaped}"`);
      }
    } else if (typeof value === 'number') {
      lines.push(`${key} = ${value}`);
    } else if (typeof value === 'boolean') {
      lines.push(`${key} = ${value}`);
    }
    // Arrays/objects intentionally not handled — all current v1 record fields
    // are scalar at the top level.
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return exec('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 });
}

async function ensureGitRepo(repo: string): Promise<void> {
  try {
    await git(repo, 'rev-parse', '--git-dir');
  } catch (err) {
    throw new Error(
      `[import-laddr] ${repo} is not a git working directory: ${describe(err)}`,
    );
  }
}

/**
 * Make sure the named branch exists locally. Returns the parent commit hash
 * we should use as the snapshot's parent — current branch tip if it exists,
 * else `initialParent`'s commit hash.
 */
async function ensureBranch(
  repo: string,
  branch: string,
  initialParent: string,
): Promise<string> {
  try {
    const { stdout } = await git(repo, 'rev-parse', '--verify', `refs/heads/${branch}`);
    return stdout.trim();
  } catch {
    // No local branch. Try `origin/<branch>` first; fall back to initialParent.
    try {
      const { stdout } = await git(repo, 'rev-parse', '--verify', `refs/remotes/origin/${branch}`);
      return stdout.trim();
    } catch {
      // ignore — fall through
    }
    const { stdout } = await git(repo, 'rev-parse', '--verify', initialParent);
    return stdout.trim();
  }
}

async function checkoutBranch(
  repo: string,
  branch: string,
  parent: string,
): Promise<void> {
  // Force-reset working tree to the desired parent under the named branch.
  await git(repo, 'checkout', '-B', branch, parent);
}

async function wipeOwnedDirectories(repo: string): Promise<void> {
  for (const dir of IMPORTER_OWNED_DIRS) {
    const full = join(repo, dir);
    // `git rm -rf -- <dir>` removes both the index entries and the working
    // tree files in one shot. The first run on a fresh branch has nothing
    // to remove, so swallow ENOENT-style failures.
    try {
      await git(repo, 'rm', '-rf', '--ignore-unmatch', '--', dir);
    } catch {
      // ignore — directory not present
    }
    // Defensively remove any leftover working-tree files (covers untracked
    // detritus from a previous --no-commit run).
    await rm(full, { recursive: true, force: true });
  }
}

interface CommitParams {
  readonly branch: string;
  readonly runAt: string;
  readonly sourceHost: string;
  readonly counts: Record<string, EntityCounts>;
}

async function createImportCommit(
  repo: string,
  p: CommitParams,
): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: p.runAt,
    GIT_COMMITTER_DATE: p.runAt,
  };

  const message = buildCommitMessage(p);
  const messageFile = join(repo, '.git', 'IMPORT_LADDR_MSG');
  await writeFile(messageFile, message, 'utf8');

  // Use `--quiet` to keep `git commit`'s stdout small (the create-mode list
  // for a 40k-file snapshot otherwise exceeds the default execFile buffer).
  await exec('git', ['commit', '--quiet', '-F', messageFile], {
    cwd: repo,
    env,
    maxBuffer: 256 * 1024 * 1024,
  });

  const { stdout: shaRaw } = await git(repo, 'rev-parse', 'HEAD');
  return shaRaw.trim();
}

function buildCommitMessage(p: CommitParams): string {
  const c = p.counts;
  const subject = `import: snapshot from ${p.sourceHost} (${p.runAt})`;
  const summary = [
    `${c['people']!.imported} people`,
    `${c['projects']!.imported} projects`,
    `${c['project-memberships']!.imported} project-memberships`,
    `${c['project-updates']!.imported} project-updates`,
    `${c['project-buzz']!.imported} project-buzz`,
    `${c['tags']!.imported} tags`,
    `${c['tag-assignments']!.imported} tag-assignments`,
  ].join(', ');

  return `${subject}\n\n${summary}.\n\nAction: import.laddr.json\nSource-Host: ${p.sourceHost}\nRun-At: ${p.runAt}\n`;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function blank(): EntityCounts {
  return { imported: 0, skipped: 0, errors: 0 };
}

function parseOrSkip<T>(
  sheet: string,
  fn: () => T,
  counts: Record<string, EntityCounts>,
  warnings: Warnings,
): T | null {
  try {
    return fn();
  } catch (err) {
    counts[sheet]!.errors++;
    warnings.push(`[${sheet}] zod validation failed: ${describe(err)}`);
    return null;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Read each importer-owned `.toml` file from the latest snapshot tip and
 * extract the record's `id` field. Used to keep UUIDs stable across re-runs
 * so an unchanged source produces an unchanged tree (idempotence).
 *
 * Reads from `refs/heads/<branch>` if it exists, then `refs/remotes/origin/
 * <branch>`, then the configured fallback. Returns an empty map if no parent
 * exists yet (first run).
 *
 * Implementation note: `git cat-file --batch` is used to stream blob contents
 * in a single subprocess rather than fork+exec per-file. Snapshots can have
 * 40k+ files; per-file `git show` calls take many minutes.
 */
async function collectExistingIds(
  repo: string,
  branch: string,
  initialParent: string,
): Promise<ExistingIds> {
  const ids = newExistingIds();
  let ref: string | null = null;
  for (const candidate of [
    `refs/heads/${branch}`,
    `refs/remotes/origin/${branch}`,
    initialParent,
  ]) {
    try {
      await git(repo, 'rev-parse', '--verify', candidate);
      ref = candidate;
      break;
    } catch {
      // try next
    }
  }
  if (ref === null) return ids;

  // `ls-tree -r` gives us mode + sha + filename for every file under the
  // commit's tree. We need both blob sha (for cat-file --batch lookup) and
  // path (so we know which sheet the record belongs to).
  let listing: string;
  try {
    const { stdout } = await git(repo, 'ls-tree', '-r', ref);
    listing = stdout;
  } catch {
    return ids;
  }

  interface Entry {
    readonly sha: string;
    readonly path: string;
  }
  const entries: Entry[] = [];
  for (const line of listing.split('\n')) {
    // Format: `<mode> <type> <sha>\t<path>`
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = line.slice(0, tabIdx).split(/\s+/);
    const path = line.slice(tabIdx + 1);
    if (meta.length < 3) continue;
    if (!path.endsWith('.toml')) continue;
    let owned = false;
    for (const dir of IMPORTER_OWNED_DIRS) {
      if (path.startsWith(`${dir}/`)) {
        owned = true;
        break;
      }
    }
    if (!owned) continue;
    entries.push({ sha: meta[2]!, path });
  }

  if (entries.length === 0) return ids;

  // Spawn `git cat-file --batch` once; feed it newline-separated SHAs on stdin,
  // parse the streamed `<sha> blob <size>\n<content>\n` responses.
  const blobs = await batchCatFile(repo, entries.map((e) => e.sha));
  for (let i = 0; i < entries.length; i++) {
    const content = blobs[i] ?? '';
    const id = extractTomlString(content, 'id');
    if (id) {
      const key = entries[i]!.path.replace(/\.toml$/, '');
      ids.byFile.set(key, id);
    }
  }
  return ids;
}

/**
 * Stream blob contents via a single `git cat-file --batch` invocation. Each
 * input SHA produces one entry in the returned array, in the same order.
 *
 * The protocol: emit one SHA per line on stdin; for each, git emits a header
 * line `<sha> <type> <size>\n` followed by `<size>` bytes of content and a
 * trailing `\n`. On `missing` (unknown SHA), git emits `<sha> missing\n` and
 * no content. We treat missing as empty.
 */
async function batchCatFile(repo: string, shas: readonly string[]): Promise<string[]> {
  if (shas.length === 0) return [];
  const { spawn } = await import('node:child_process');
  return await new Promise<string[]>((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const results: string[] = [];
    let stderrAcc = '';
    let buf = Buffer.alloc(0);
    let mode: 'header' | 'content' = 'header';
    let expected = 0;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrAcc += chunk;
    });

    child.stdout.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (mode === 'header') {
          const nl = buf.indexOf(0x0a);
          if (nl === -1) return;
          const header = buf.slice(0, nl).toString('utf8');
          buf = buf.slice(nl + 1);
          // header is `<sha> <type> <size>` or `<sha> missing`
          const parts = header.split(' ');
          if (parts.length === 3 && parts[1] !== 'missing') {
            expected = parseInt(parts[2]!, 10);
            mode = 'content';
          } else {
            // missing — no content body
            results.push('');
            if (results.length === shas.length) {
              try {
                child.stdin.end();
              } catch {
                // ignore
              }
            }
          }
        } else {
          // content mode: wait for `expected` bytes + the trailing newline
          if (buf.length < expected + 1) return;
          const content = buf.slice(0, expected).toString('utf8');
          buf = buf.slice(expected + 1); // skip trailing newline
          results.push(content);
          mode = 'header';
          if (results.length === shas.length) {
            try {
              child.stdin.end();
            } catch {
              // ignore
            }
          }
        }
      }
    });

    child.on('close', (code) => {
      if (code !== 0 && results.length !== shas.length) {
        reject(new Error(`git cat-file --batch exited ${code}: ${stderrAcc}`));
      } else {
        resolve(results);
      }
    });
    child.on('error', reject);

    // Feed SHAs as a single write — git's batch mode reads to EOL.
    const payload = shas.join('\n') + '\n';
    child.stdin.write(payload);
    // Don't end stdin yet — close it when all entries have been read so the
    // batch process drains cleanly. (Closing early on a slow consumer would
    // truncate output.)
  });
}

function extractTomlString(content: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*=\\s*"(.*)"$`, 'm');
  const m = content.match(re);
  if (m === null) return null;
  // Reverse the simple TOML escapes used by our writer.
  return (m[1] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// Exposed for direct invocation in tests that walk the tree.
export { IMPORTER_OWNED_DIRS };

// Used by tests that want to introspect the unused-but-imported readdir helper.
export async function listOwnedToml(repo: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of IMPORTER_OWNED_DIRS) {
    const full = join(repo, dir);
    try {
      for (const entry of await readdir(full, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.toml')) {
          out.push(`${dir}/${entry.name}`);
        }
      }
    } catch {
      // dir not present
    }
  }
  return out;
}
