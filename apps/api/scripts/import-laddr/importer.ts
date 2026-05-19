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
 *   - On subsequent runs, the importer checks out the existing local branch,
 *     opens the gitsheets store, reads the previous snapshot's record UUIDs
 *     (to keep them stable across re-runs), then opens a single transaction
 *     that clears each importer-owned sheet and re-upserts the fresh data.
 *   - Files are written by gitsheets per each sheet's path template
 *     (e.g. `people/${{ slug }}.toml`) — the runtime API reads the same paths.
 *     The legacy-import branch's tree is shape-identical to fixture/main; the
 *     operator's merge into main is a plain `git merge`, no rename pass.
 *
 * Author identity on every commit: the pseudonymous Code for Philly API
 * user. The agent's git config is never used (gitsheets honors `author`
 * directly on `transact`).
 *
 * Side effects:
 *   - Checks out the target branch in the data repo's working tree
 *   - Creates one commit on the local `legacy-import` branch (via gitsheets)
 *   - Does NOT push to origin (operator's call)
 *
 * Private-store side: out of scope for this importer. The JSON endpoints
 * expose only public fields; private data (emails, password hashes,
 * newsletter prefs) will be imported separately on a future plan.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
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

import { openPublicStore, type PublicStore } from '../../src/store/public.js';
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
  /** Commit hash produced, or null in `--dry-run` / no-changes. */
  readonly commitHash: string | null;
  /** True when the produced tree matches HEAD's (no commit was made). */
  readonly noChanges: boolean;
}

const AUTHOR_NAME = 'Code for Philly API';
const AUTHOR_EMAIL = 'api@users.noreply.codeforphilly.org';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function importLaddrFromJson(opts: ImportOptions): Promise<ImportReport> {
  const runAt = opts.now ?? new Date().toISOString();
  const branch = opts.branch ?? 'legacy-import';
  const initialParent = opts.initialParent ?? 'origin/empty';
  const log = opts.verbose ? (msg: string) => console.log(msg) : (): void => {};

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
  const repo = resolve(opts.dataRepo);

  // -------------------------------------------------------------------------
  // 0. Pre-pass — for non-dry-run, switch to the target branch and read
  //    existing UUIDs from the previous snapshot so re-runs are idempotent.
  //    Without this, every run mints fresh UUIDs and every commit diffs
  //    against the last even when nothing changed upstream.
  // -------------------------------------------------------------------------
  let store: PublicStore | null = null;
  let existingIds: ExistingIds;

  if (opts.dryRun) {
    existingIds = newExistingIds();
  } else {
    await ensureGitRepo(repo);
    await ensureBranchCheckedOut(repo, branch, initialParent);
    const opened = await openPublicStore(repo);
    store = opened.store;
    existingIds = await collectExistingIds(store, log);
  }

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
  for await (const row of fetchAllPages<RawTag>('/tags', RawTagSchema, {}, fetchOpts)) {
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
  // 3. One atomic gitsheets transaction:
  //    - clear() each importer-owned sheet (deletes capture for free)
  //    - upsert() every translated record (path-template + schema validation)
  // -------------------------------------------------------------------------
  if (store === null) throw new Error('[import-laddr] internal: store not opened');

  const message = buildCommitMessage({ runAt, sourceHost: opts.sourceHost, counts });

  const result = await store.transact(
    {
      message,
      author: { name: AUTHOR_NAME, email: AUTHOR_EMAIL },
      trailers: {
        Action: 'import.laddr.json',
        'Source-Host': opts.sourceHost,
        'Run-At': runAt,
      },
    },
    async (tx) => {
      log(`[import] clear + upsert tags (${tags.length})`);
      await tx.tags.clear();
      for (const t of tags) await tx.tags.upsert(t);

      log(`[import] clear + upsert people (${people.length})`);
      await tx.people.clear();
      for (const p of people) await tx.people.upsert(p);

      log(`[import] clear + upsert projects (${projects.length})`);
      await tx.projects.clear();
      for (const p of projects) await tx.projects.upsert(p);

      log(`[import] clear + upsert project-memberships (${memberships.length})`);
      await tx['project-memberships'].clear();
      for (const m of memberships) {
        const projectSlug = idMaps.projectSlugByLegacy.get(m.legacyIds.projectLegacyId);
        const personSlug = idMaps.personSlugByLegacy.get(m.legacyIds.personLegacyId);
        if (!projectSlug || !personSlug) {
          warnings.push(
            `[project-memberships] skipped: missing slug for project=${m.legacyIds.projectLegacyId} or person=${m.legacyIds.personLegacyId}`,
          );
          continue;
        }
        await tx['project-memberships'].upsert({
          ...m.record,
          projectSlug,
          personSlug,
        } as ProjectMembership);
      }

      log(`[import] clear + upsert project-updates (${updates.length})`);
      await tx['project-updates'].clear();
      for (const { record, projectLegacyId } of updates) {
        const projectSlug = idMaps.projectSlugByLegacy.get(projectLegacyId);
        if (!projectSlug) {
          warnings.push(
            `[project-updates] skipped: missing slug for project=${projectLegacyId}`,
          );
          continue;
        }
        await tx['project-updates'].upsert({ ...record, projectSlug } as ProjectUpdate);
      }

      log(`[import] clear + upsert project-buzz (${buzz.length})`);
      await tx['project-buzz'].clear();
      for (const { record, projectLegacyId } of buzz) {
        const projectSlug = idMaps.projectSlugByLegacy.get(projectLegacyId);
        if (!projectSlug) {
          warnings.push(
            `[project-buzz] skipped: missing slug for project=${projectLegacyId}`,
          );
          continue;
        }
        await tx['project-buzz'].upsert({ ...record, projectSlug } as ProjectBuzz);
      }

      log(`[import] clear + upsert tag-assignments (${tagAssignments.length})`);
      await tx['tag-assignments'].clear();
      for (const ta of tagAssignments) await tx['tag-assignments'].upsert(ta);
    },
  );

  // gitsheets' Transaction#finalize doesn't compare the resulting tree-hash
  // to the parent's tree-hash before committing — it commits whenever any
  // mutating method was called, even if the tree ended up byte-identical
  // (e.g. `clear()` + re-`upsert()` of the same records). Filed as
  // JarvusInnovations/gitsheets#179. Until that lands, detect the no-op here
  // and reset the ref so the snapshot history stays clean.
  let commitHash: string | null = result.commitHash;
  let noChanges = commitHash === null;
  if (commitHash !== null && result.parentCommitHash !== null && result.treeHash !== null) {
    const parentTreeHash = (
      await exec('git', ['rev-parse', `${result.parentCommitHash}^{tree}`], { cwd: repo })
    ).stdout.trim();
    if (parentTreeHash === result.treeHash) {
      await exec('git', ['update-ref', `refs/heads/${branch}`, result.parentCommitHash, commitHash], {
        cwd: repo,
      });
      commitHash = null;
      noChanges = true;
      log('[import] tree matches parent — reset ref (no-op snapshot)');
    }
  }

  return {
    runAt,
    sourceHost: opts.sourceHost,
    branch,
    counts,
    warnings: warningsList,
    commitHash,
    noChanges,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CommitParams {
  readonly runAt: string;
  readonly sourceHost: string;
  readonly counts: Record<string, EntityCounts>;
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

  return `${subject}\n\n${summary}.\n`;
}

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

// ---------------------------------------------------------------------------
// Git plumbing (branch checkout only — gitsheets handles commit creation)
// ---------------------------------------------------------------------------

async function ensureGitRepo(repo: string): Promise<void> {
  try {
    await exec('git', ['rev-parse', '--git-dir'], { cwd: repo });
  } catch (err) {
    throw new Error(
      `[import-laddr] ${repo} is not a git working directory: ${describe(err)}`,
      { cause: err },
    );
  }
}

/**
 * Check out the target branch in the working tree. On first run, create it
 * from `origin/<branch>` if available, falling back to `initialParent`
 * (typically `origin/empty`).
 */
async function ensureBranchCheckedOut(
  repo: string,
  branch: string,
  initialParent: string,
): Promise<void> {
  // Existing local branch: just switch.
  try {
    await exec('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repo });
    await exec('git', ['checkout', branch], { cwd: repo });
    return;
  } catch {
    // No local branch — fall through.
  }
  // No local branch yet. Try origin/<branch>, fall back to initialParent.
  let parent: string;
  try {
    await exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
      cwd: repo,
    });
    parent = `origin/${branch}`;
  } catch {
    parent = initialParent;
  }
  await exec('git', ['checkout', '-b', branch, parent], { cwd: repo });
}

// ---------------------------------------------------------------------------
// Pre-pass: read existing UUIDs from the current snapshot so re-runs preserve
// each record's `id` field. Keys mirror the translator's `idFor(ctx, key)`
// calls.
//
// Simple sheets (people, projects, tags, project-updates, project-buzz)
// carry `legacyId` directly on the record, so we read them in one pass.
// Composite-path sheets (project-memberships, tag-assignments) don't store
// legacy IDs on the record; we recover them via uuid→legacyId reverse maps
// built from the simple-sheet pass.
// ---------------------------------------------------------------------------

async function collectExistingIds(
  store: PublicStore,
  log: (msg: string) => void,
): Promise<ExistingIds> {
  const ids = newExistingIds();
  let count = 0;

  // Pass 1: simple sheets. Also build uuid → legacyId reverse maps used by
  // the composite-sheet pass below.
  const personLegacyByUuid = new Map<string, number>();
  const projectLegacyByUuid = new Map<string, number>();
  const tagLegacyByUuid = new Map<string, number>();

  const simpleSheets = ['people', 'projects', 'tags', 'project-updates', 'project-buzz'] as const;
  for (const sheetName of simpleSheets) {
    const sheet = store[sheetName] as { query: () => AsyncIterable<Record<string, unknown>> };
    for await (const record of sheet.query()) {
      const legacyId = record['legacyId'];
      const id = record['id'];
      if (typeof legacyId === 'number' && typeof id === 'string') {
        ids.byFile.set(`${sheetName}/${legacyId}`, id);
        count++;
        if (sheetName === 'people') personLegacyByUuid.set(id, legacyId);
        else if (sheetName === 'projects') projectLegacyByUuid.set(id, legacyId);
        else if (sheetName === 'tags') tagLegacyByUuid.set(id, legacyId);
      }
    }
  }

  // Pass 2: composite-path sheets. Look up legacy IDs for the referenced
  // entities; skip records that point at uuids we couldn't resolve.
  const membershipsSheet = store['project-memberships'] as {
    query: () => AsyncIterable<Record<string, unknown>>;
  };
  for await (const record of membershipsSheet.query()) {
    const projectId = record['projectId'];
    const personId = record['personId'];
    const id = record['id'];
    if (typeof id !== 'string' || typeof projectId !== 'string' || typeof personId !== 'string') {
      continue;
    }
    const projectLegacyId = projectLegacyByUuid.get(projectId);
    const personLegacyId = personLegacyByUuid.get(personId);
    if (projectLegacyId === undefined || personLegacyId === undefined) continue;
    ids.byFile.set(`project-memberships/${projectLegacyId}-${personLegacyId}`, id);
    count++;
  }

  const tagAssignmentsSheet = store['tag-assignments'] as {
    query: () => AsyncIterable<Record<string, unknown>>;
  };
  for await (const record of tagAssignmentsSheet.query()) {
    const tagId = record['tagId'];
    const taggableId = record['taggableId'];
    const taggableType = record['taggableType'];
    const id = record['id'];
    if (
      typeof id !== 'string' ||
      typeof tagId !== 'string' ||
      typeof taggableId !== 'string' ||
      (taggableType !== 'project' && taggableType !== 'person')
    ) {
      continue;
    }
    const tagLegacyId = tagLegacyByUuid.get(tagId);
    const taggableLegacyId =
      taggableType === 'project'
        ? projectLegacyByUuid.get(taggableId)
        : personLegacyByUuid.get(taggableId);
    if (tagLegacyId === undefined || taggableLegacyId === undefined) continue;
    ids.byFile.set(
      `tag-assignments/${tagLegacyId}-${taggableType}-${taggableLegacyId}`,
      id,
    );
    count++;
  }

  log(`[import] pre-pass: preserved ${count} record UUIDs from previous snapshot`);
  return ids;
}
