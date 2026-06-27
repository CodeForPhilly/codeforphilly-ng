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
  BlogPostSchema,
  PersonSchema,
  ProjectBuzzSchema,
  ProjectMembershipSchema,
  ProjectSchema,
  ProjectUpdateSchema,
  TagAssignmentSchema,
  TagSchema,
} from '@cfp/shared/schemas';
import type {
  BlogPost,
  Person,
  Project,
  ProjectBuzz,
  ProjectMembership,
  ProjectUpdate,
  Tag,
  TagAssignment,
} from '@cfp/shared/schemas';

import { openPublicStore, type PublicStore } from '../../src/store/public.js';
import { processAvatar } from '../../src/lib/avatar.js';
import {
  fetchAllPages,
  RawBlogPostSchema,
  RawPersonSchema,
  RawProjectBuzzSchema,
  RawProjectSchema,
  RawProjectUpdateSchema,
  RawTagSchema,
  type FetchOptions,
  type RawBlogPost,
  type RawPerson,
  type RawProject,
  type RawProjectBuzz,
  type RawProjectUpdate,
  type RawTag,
} from './json-fetcher.js';
import {
  mediaPlaceholderUrl,
  newExistingIds,
  newIdMaps,
  translateBlogPost,
  translateBuzz,
  translateMembership,
  translatePerson,
  translateProject,
  translateTag,
  translateTagAssignment,
  translateUpdate,
  type BlogMediaAsset,
  type ExistingIds,
  type TranslateCtx,
  type Warnings,
} from './translators.js';
import { BlobObject } from 'hologit';

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
    'blog-posts': blank(),
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
  // Gitsheets Repository — needed to write attachment blobs via
  // BlobObject.write into the underlying git object DB.
  let publicRepo: Awaited<ReturnType<typeof openPublicStore>>['repo'] | null = null;
  let existingIds: ExistingIds;

  if (opts.dryRun) {
    existingIds = newExistingIds();
  } else {
    await ensureGitRepo(repo);
    await ensureBranchCheckedOut(repo, branch, initialParent);
    const opened = await openPublicStore(repo);
    store = opened.store;
    publicRepo = opened.repo;
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
  // slug → laddr PrimaryPhotoID, for people who have a profile photo. Their
  // avatars are fetched from `/media/<id>` and stored as gitsheets attachments.
  const photoIdBySlug = new Map<string, number>();
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
      if (typeof row.PrimaryPhotoID === 'number') {
        photoIdBySlug.set(parsed.slug, row.PrimaryPhotoID);
      }
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

  log(`[import] fetching blog from ${opts.sourceHost}`);
  // `?include=*` is the only way to get the body content — laddr stores
  // it as a typed `items` array on `AbstractContent`, not as a flat Body
  // field. translateBlogPost assembles markdown from those items and
  // returns the record alongside a media-asset plan.
  const blogTranslations: Array<{
    record: BlogPost;
    mediaAssets: readonly BlogMediaAsset[];
  }> = [];
  for await (const row of fetchAllPages<RawBlogPost>(
    '/blog',
    RawBlogPostSchema,
    { include: '*' },
    fetchOpts,
  )) {
    const t = translateBlogPost(row, ctx);
    if (t === null) {
      counts['blog-posts']!.skipped++;
      continue;
    }
    const parsedRecord = parseOrSkip(
      'blog-posts',
      () => BlogPostSchema.parse(t.record),
      counts,
      warnings,
    );
    if (parsedRecord) {
      blogTranslations.push({ record: parsedRecord, mediaAssets: t.mediaAssets });
      counts['blog-posts']!.imported++;
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
  // 2a. Pre-fetch blog post media assets.
  //
  // Each translated blog post may reference some number of laddr Media
  // items by their numeric MediaID. We fetch the original bytes for each
  // referenced MediaID, derive a content-type-aware filename, and rewrite
  // the placeholder URLs in each post's body (`cfp-media:<id>`) to the
  // final `/api/attachments/blog-posts/<slug>/<filename>` URL.
  //
  // Failed fetches don't block the import — the markdown link will 404
  // at serve time, but the post itself still imports with the rest of
  // its body intact.
  // -------------------------------------------------------------------------
  const mediaArtifactsBySlug = await fetchAndMaterializeBlogMedia(
    blogTranslations,
    fetchOpts,
    log,
    warnings,
  );

  // Fetch + process person avatars from laddr (`/media/<PrimaryPhotoID>`) into
  // square original + 128px thumbnail buffers, keyed by person slug.
  const avatarsBySlug = await fetchAndMaterializePersonAvatars(
    photoIdBySlug,
    opts.sourceHost,
    fetchOpts,
    log,
    warnings,
  );

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
      if (publicRepo === null) {
        throw new Error('[import-laddr] internal: publicRepo not opened');
      }
      const hologit = publicRepo.hologitRepo;

      log(`[import] clear + upsert tags (${tags.length})`);
      await tx.tags.clear();
      for (const t of tags) await tx.tags.upsert(t);

      log(`[import] clear + upsert people (${people.length}, avatars: ${avatarsBySlug.size})`);
      await tx.people.clear();
      for (const p of people) {
        const avatar = avatarsBySlug.get(p.slug);
        if (avatar) {
          // Mirror POST /api/people/:slug/avatar: store original + 128 thumb
          // as attachments and point avatarKey at the conventional path.
          const originalBlob = await BlobObject.write(hologit, avatar.original as unknown as string);
          const thumbnailBlob = await BlobObject.write(hologit, avatar.thumbnail as unknown as string);
          await tx.people.setAttachments(p, {
            'avatar.jpg': originalBlob,
            'avatar-128.jpg': thumbnailBlob,
          });
          await tx.people.upsert({ ...p, avatarKey: `people/${p.slug}/avatar.jpg` });
        } else {
          await tx.people.upsert(p);
        }
      }

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

      log(
        `[import] clear + upsert blog-posts (${blogTranslations.length}) + media attachments`,
      );
      await tx['blog-posts'].clear();
      for (const { record } of blogTranslations) {
        const artifacts = mediaArtifactsBySlug.get(record.slug) ?? [];
        if (artifacts.length > 0) {
          const blobs: Record<string, BlobObject> = {};
          for (const a of artifacts) {
            // BlobObject.write hashes the buffer into the git object DB.
            // Same `as unknown as string` cast as the avatar route — the
            // declared signature is too narrow; the underlying
            // git-client `$putBlob` accepts Buffer at runtime.
            blobs[a.filename] = await BlobObject.write(
              hologit,
              a.bytes as unknown as string,
            );
          }
          await tx['blog-posts'].setAttachments(record, blobs);
        }
        await tx['blog-posts'].upsert(record);
      }

      log(`[import] clear + upsert tag-assignments (${tagAssignments.length})`);
      await tx['tag-assignments'].clear();
      for (const ta of tagAssignments) await tx['tag-assignments'].upsert(ta);
    },
  );

  // gitsheets v1.3.1+ compares the post-transact tree-hash to the parent's
  // tree-hash and returns commitHash=null when they match (no-op snapshot).
  // No workaround needed.
  return {
    runAt,
    sourceHost: opts.sourceHost,
    branch,
    counts,
    warnings: warningsList,
    commitHash: result.commitHash,
    noChanges: result.commitHash === null,
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
    `${c['blog-posts']!.imported} blog-posts`,
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
 * Point HEAD at the target branch in the bare data repo. On first run,
 * the branch ref is created from `origin/<branch>` if available, falling
 * back to `initialParent` (typically `origin/empty`).
 *
 * Bare-friendly — no working tree to check out into. The branch ref is
 * created/updated via `git update-ref`, and HEAD becomes a symbolic-ref
 * pointing at it so subsequent transacts commit onto the right branch.
 */
async function ensureBranchCheckedOut(
  repo: string,
  branch: string,
  initialParent: string,
): Promise<void> {
  // Resolve the parent commit hash: either the existing local branch (use
  // it as-is), origin/<branch> if it exists, or the initialParent fallback.
  let parentCommit: string;
  try {
    const result = await exec('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repo });
    parentCommit = result.stdout.trim();
  } catch {
    // No local branch — try origin/<branch>, fall back to initialParent.
    let parentRef: string;
    try {
      await exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
        cwd: repo,
      });
      parentRef = `refs/remotes/origin/${branch}`;
    } catch {
      parentRef = initialParent;
    }
    const result = await exec('git', ['rev-parse', '--verify', parentRef], { cwd: repo });
    parentCommit = result.stdout.trim();
    await exec('git', ['update-ref', `refs/heads/${branch}`, parentCommit], { cwd: repo });
  }

  // Point HEAD at the (now-existing) branch so subsequent gitsheets
  // transacts commit onto it.
  await exec('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: repo });
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

  const simpleSheets = ['people', 'projects', 'tags', 'project-updates', 'project-buzz', 'blog-posts'] as const;
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

// ---------------------------------------------------------------------------
// Blog media pre-fetch + materialization
// ---------------------------------------------------------------------------

/**
 * One materialized attachment ready to be written into the gitsheets tree.
 */
interface BlogMediaArtifact {
  /** Filename (with extension) — relative to `blog-posts/<slug>/`. */
  readonly filename: string;
  /** Original bytes. */
  readonly bytes: Buffer;
}

/** Content-Type → file extension. Unknown types → null (skipped). */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

function extFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  // `image/jpeg; charset=…` → `image/jpeg`.
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXT_BY_MIME[base] ?? null;
}

/**
 * Fetch one media asset's bytes + content-type. Returns null on any
 * non-2xx or unexpected error — the import shouldn't abort because one
 * image disappeared upstream.
 */
async function fetchMediaBytes(
  url: string,
  fetchImpl: typeof fetch,
  userAgent: string,
): Promise<{ bytes: Buffer; contentType: string | null } | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': userAgent },
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return {
      bytes: Buffer.from(ab),
      contentType: res.headers.get('content-type'),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch each person's laddr photo (`/media/<PrimaryPhotoID>`) and process it
 * into a square original + 128px thumbnail (the same outputs the avatar-upload
 * route produces). Returns a map of person slug → buffers for the transact
 * callback to wire in via setAttachments. Failed fetches/decodes are skipped
 * with a warning — the person still imports, just without an avatar.
 *
 * Concurrency 4, matching the blog-media fetcher's politeness compromise.
 */
async function fetchAndMaterializePersonAvatars(
  photoIdBySlug: Map<string, number>,
  sourceHost: string,
  fetchOpts: FetchOptions,
  log: (msg: string) => void,
  warnings: Warnings,
): Promise<Map<string, { original: Buffer; thumbnail: Buffer }>> {
  const fetchImpl = fetchOpts.fetchImpl ?? fetch;
  const userAgent = fetchOpts.userAgent ?? 'cfp-importer/dev';
  const entries = [...photoIdBySlug.entries()];
  const out = new Map<string, { original: Buffer; thumbnail: Buffer }>();
  if (entries.length === 0) return out;

  log(`[import] fetching ${entries.length} person avatars`);

  const CONCURRENCY = 4;
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= entries.length) return;
          const [slug, photoId] = entries[idx]!;
          const url = `https://${sourceHost}/media/${photoId}`;
          const fetched = await fetchMediaBytes(url, fetchImpl, userAgent);
          if (fetched === null) {
            warnings.push(`[people] avatar fetch failed: ${url} (/${slug})`);
            continue;
          }
          try {
            const processed = await processAvatar(fetched.bytes);
            out.set(slug, { original: processed.original, thumbnail: processed.thumbnail });
          } catch (err) {
            warnings.push(`[people] avatar decode failed for /${slug} (${url}): ${describe(err)}`);
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  log(`[import] processed ${out.size}/${entries.length} person avatars`);
  return out;
}

/**
 * Fetch every distinct media asset referenced across all blog posts,
 * derive the final filename per asset, then rewrite each post's body to
 * replace `cfp-media:<id>` placeholders with the final
 * `/api/attachments/blog-posts/<slug>/<filename>` URL.
 *
 * Returns the map of artifacts keyed by post slug, ready for the
 * transact callback to wire into gitsheets via setAttachments.
 *
 * Same MediaID can appear in multiple posts (rare but possible). Each
 * post gets its own copy of the asset under its own subdir — the
 * git object DB dedupes the bytes by content hash, so the repo size
 * cost is the metadata overhead per reference, not the bytes.
 *
 * Concurrency: 4 parallel fetches at a time (a politeness compromise
 * — fewer would slow imports; more would hammer laddr). The JSON
 * fetcher's per-page `delayMs` doesn't apply here since these are
 * binary endpoints, not paged JSON.
 */
async function fetchAndMaterializeBlogMedia(
  blogTranslations: Array<{ record: BlogPost; mediaAssets: readonly BlogMediaAsset[] }>,
  fetchOpts: FetchOptions,
  log: (msg: string) => void,
  warnings: Warnings,
): Promise<Map<string, BlogMediaArtifact[]>> {
  const fetchImpl = fetchOpts.fetchImpl ?? fetch;
  const userAgent = fetchOpts.userAgent ?? 'cfp-importer/dev';

  // Flatten so we can drive parallel fetches across all posts.
  const flat: Array<{
    ownerSlug: string;
    asset: BlogMediaAsset;
  }> = [];
  for (const { record, mediaAssets } of blogTranslations) {
    for (const asset of mediaAssets) {
      flat.push({ ownerSlug: record.slug, asset });
    }
  }

  log(`[import] fetching ${flat.length} blog media assets`);

  /** What the fetch loop produces per asset. */
  interface FetchedAsset {
    readonly ownerSlug: string;
    readonly asset: BlogMediaAsset;
    readonly bytes: Buffer | null;
    readonly ext: string | null;
  }

  const results: FetchedAsset[] = [];
  const CONCURRENCY = 4;
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= flat.length) return;
          const entry = flat[idx]!;
          const fetched = await fetchMediaBytes(entry.asset.sourceUrl, fetchImpl, userAgent);
          if (fetched === null) {
            warnings.push(
              `[blog-posts] media fetch failed: ${entry.asset.sourceUrl} (referenced by /${entry.ownerSlug})`,
            );
            results.push({
              ownerSlug: entry.ownerSlug,
              asset: entry.asset,
              bytes: null,
              ext: null,
            });
            continue;
          }
          const ext = extFromContentType(fetched.contentType);
          if (ext === null) {
            warnings.push(
              `[blog-posts] media ${entry.asset.sourceUrl} returned unsupported Content-Type ${JSON.stringify(fetched.contentType)}; skipped`,
            );
            results.push({
              ownerSlug: entry.ownerSlug,
              asset: entry.asset,
              bytes: null,
              ext: null,
            });
            continue;
          }
          results.push({
            ownerSlug: entry.ownerSlug,
            asset: entry.asset,
            bytes: fetched.bytes,
            ext,
          });
        }
      })(),
    );
  }
  await Promise.all(workers);

  // Build the placeholder → final URL substitution table per post, plus
  // the artifact list keyed by post slug.
  const artifactsBySlug = new Map<string, BlogMediaArtifact[]>();
  const substitutionByPost = new Map<string, Map<string, string>>();
  for (const r of results) {
    if (r.bytes === null || r.ext === null) continue;
    const filename = `${r.asset.captionSlug}-${r.asset.mediaId}.${r.ext}`;
    const finalUrl = `/api/attachments/blog-posts/${r.ownerSlug}/${filename}`;

    let arts = artifactsBySlug.get(r.ownerSlug);
    if (!arts) {
      arts = [];
      artifactsBySlug.set(r.ownerSlug, arts);
    }
    arts.push({ filename, bytes: r.bytes });

    let subs = substitutionByPost.get(r.ownerSlug);
    if (!subs) {
      subs = new Map();
      substitutionByPost.set(r.ownerSlug, subs);
    }
    subs.set(mediaPlaceholderUrl(r.asset.mediaId), finalUrl);
  }

  // Walk records and substitute placeholders in their bodies.
  for (const t of blogTranslations) {
    const subs = substitutionByPost.get(t.record.slug);
    if (!subs || subs.size === 0) continue;
    let body = t.record.body;
    for (const [placeholder, finalUrl] of subs) {
      body = body.split(placeholder).join(finalUrl);
    }
    // Mutate the record in place — it's been Zod-validated already and
    // the schema just requires `body: string`, no need to reparse.
    (t.record as { body: string }).body = body;
  }

  return artifactsBySlug;
}
