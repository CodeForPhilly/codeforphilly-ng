/**
 * Orchestrator: one-shot laddr → v1 migration.
 *
 * Public side: one gitsheets commit per entity type (7 commits), all under
 * a single pseudonymous author per specs/behaviors/storage.md. Idempotence
 * comes from a pre-pass that builds `byLegacyId.<entity>` from any existing
 * records in the data repo; subsequent rows with the same `legacyId` are
 * skipped (insert-if-absent semantics rather than always-overwrite, because
 * re-running an import is only meant to backfill rows added since).
 *
 * Private side: PrivateProfile + LegacyPasswordCredential land in the
 * private store via a single transact() at the end of the people pass.
 *
 * All writes are gated by `--dry-run`. In dry-run mode the script counts
 * and validates everything but never touches the git repo or private store.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';

import { openRepo } from 'gitsheets';

const exec = promisify(execFile);
import {
  LegacyPasswordCredentialSchema,
  PersonSchema,
  PrivateProfileSchema,
  ProjectBuzzSchema,
  ProjectMembershipSchema,
  ProjectSchema,
  ProjectUpdateSchema,
  TagAssignmentSchema,
  TagSchema,
} from '@cfp/shared/schemas';
import type {
  LegacyPasswordCredential,
  Person,
  PrivateProfile,
  Project,
  ProjectBuzz,
  ProjectMembership,
  ProjectUpdate,
  Tag,
  TagAssignment,
} from '@cfp/shared/schemas';

import type { PrivateStore } from '../../src/store/private/interface.js';
import { streamRows, type Row } from './mysqldump-parser.js';
import {
  newIdMaps,
  translateBuzz,
  translateMembership,
  translatePerson,
  translateProject,
  translateTag,
  translateTagAssignment,
  translateUpdate,
  type IdMaps,
  type Warnings,
} from './translators.js';

export interface ImportOptions {
  readonly sql: string;
  readonly dataRepo: string;
  readonly privateStore: PrivateStore;
  readonly dryRun?: boolean;
  readonly verbose?: boolean;
  /** Per-table truncation: stop after N rows of each table. */
  readonly limit?: number;
  /** Override the import wall clock for deterministic tests. */
  readonly now?: string;
}

export interface EntityReport {
  input: number;
  imported: number;
  skipped: number;
  errors: number;
}

export interface ImportReport {
  readonly sourceSha256: string;
  readonly runAt: string;
  readonly entities: Record<string, EntityReport>;
  readonly warnings: string[];
  /** Commit hashes produced (in order), or [] in dry-run. */
  readonly commits: string[];
}

const AUTHOR_NAME = 'Code for Philly API';
const AUTHOR_EMAIL = 'api@users.noreply.codeforphilly.org';

interface RunState {
  readonly idMaps: IdMaps;
  readonly warnings: Warnings;
  readonly entities: Record<string, EntityReport>;
  readonly opts: ImportOptions;
  readonly now: string;
  readonly sourceSha256: string;
  readonly commits: string[];
  readonly existing: ExistingLegacyIds;
}

interface ExistingLegacyIds {
  /** legacyId → { id, slug } */
  readonly people: Map<number, { id: string; slug: string }>;
  readonly projects: Map<number, { id: string; slug: string }>;
  readonly tags: Map<number, string>;
  readonly projectUpdates: Set<number>;
  readonly projectBuzz: Set<number>;
  /**
   * Membership composite keys (`projectSlug/personSlug`) already committed —
   * memberships have no legacyId of their own to dedupe on, so path-presence
   * is the truth.
   */
  readonly membershipPaths: Set<string>;
  /** Tag-assignment composite keys (`tagId/type/taggableId`) already committed. */
  readonly tagAssignmentPaths: Set<string>;
}

export async function importLaddr(opts: ImportOptions): Promise<ImportReport> {
  const warnings: string[] = [];
  const sink: Warnings = {
    push: (w) => {
      warnings.push(w);
      if (opts.verbose) console.warn(w);
    },
  };

  const sourceSha256 = await hashFile(opts.sql);
  const now = opts.now ?? new Date().toISOString();

  const entities: Record<string, EntityReport> = {
    people: blank(),
    projects: blank(),
    'project-memberships': blank(),
    'project-updates': blank(),
    'project-buzz': blank(),
    tags: blank(),
    'tag-assignments': blank(),
  };

  const existing = await collectExistingLegacyIds(opts.dataRepo);

  const state: RunState = {
    idMaps: newIdMaps(),
    warnings: sink,
    entities,
    opts,
    now,
    sourceSha256,
    commits: [],
    existing,
  };

  // Order matters — FK resolution depends on earlier passes filling the id
  // maps. Each pass yields rows lazily via streamRows; on dry-run nothing
  // is written but counts/warnings still tally correctly.
  await importTags(state);
  await importPeople(state);
  await importProjects(state);
  await importMemberships(state);
  await importProjectUpdates(state);
  await importProjectBuzz(state);
  await importTagAssignments(state);

  return {
    sourceSha256,
    runAt: now,
    entities,
    warnings,
    commits: state.commits,
  };
}

// ---------------------------------------------------------------------------
// Per-entity passes
// ---------------------------------------------------------------------------

async function importTags(state: RunState): Promise<void> {
  const records: Tag[] = [];
  for await (const row of takeRows(state, 'tags')) {
    const legacyId = numericId(row, 'ID');
    if (legacyId !== null && state.existing.tags.has(legacyId)) {
      state.entities.tags!.skipped++;
      state.idMaps.tagByLegacy.set(legacyId, state.existing.tags.get(legacyId)!);
      continue;
    }
    const r = safeRun(state, 'tags', () => translateTag(row, ctxFor(state)));
    if (!r) continue;
    const parsed = parseOrSkip(state, 'tags', () => TagSchema.parse(r));
    if (parsed) {
      records.push(parsed);
      state.entities.tags!.imported++;
    }
  }

  await commit(state, 'tags', `${records.length} tags`, async (tx) => {
    const sheet = tx.sheet('tags');
    for (const r of records) await sheet.upsert(r as unknown as Record<string, unknown>);
  });
}

async function importPeople(state: RunState): Promise<void> {
  const people: Person[] = [];
  const profiles: PrivateProfile[] = [];
  const legacyPasswords: LegacyPasswordCredential[] = [];

  for await (const row of takeRows(state, 'people')) {
    const legacyId = numericId(row, 'ID');
    if (legacyId !== null && state.existing.people.has(legacyId)) {
      state.entities.people!.skipped++;
      const existing = state.existing.people.get(legacyId)!;
      state.idMaps.personByLegacy.set(legacyId, existing.id);
      state.idMaps.personSlugById.set(existing.id, existing.slug);
      const used = state.idMaps.usedSlugs.get('people') ?? new Set<string>();
      used.add(existing.slug);
      state.idMaps.usedSlugs.set('people', used);
      continue;
    }
    const r = safeRun(state, 'people', () => translatePerson(row, ctxFor(state)));
    if (!r) continue;

    const parsedPerson = parseOrSkip(state, 'people', () => PersonSchema.parse(r.person));
    if (!parsedPerson) continue;
    people.push(parsedPerson);
    state.entities.people!.imported++;

    if (r.privateProfile) {
      const parsedProfile = parseOrSkip(
        state,
        'private-profiles',
        () => PrivateProfileSchema.parse(r.privateProfile),
      );
      if (parsedProfile) profiles.push(parsedProfile);
    }
    if (r.legacyPassword) {
      const parsedLp = parseOrSkip(
        state,
        'legacy-passwords',
        () => LegacyPasswordCredentialSchema.parse(r.legacyPassword),
      );
      if (parsedLp) legacyPasswords.push(parsedLp);
    }
  }

  await commit(state, 'people', `${people.length} people`, async (tx) => {
    const sheet = tx.sheet('people');
    for (const r of people) await sheet.upsert(r as unknown as Record<string, unknown>);
  });

  if (state.opts.dryRun) return;

  if (profiles.length > 0) {
    await state.opts.privateStore.transact(async (privTx) => {
      for (const p of profiles) privTx.putProfile(p);
    });
  }
  if (legacyPasswords.length > 0) {
    await writeLegacyPasswords(state.opts.privateStore, legacyPasswords);
  }
}

async function importProjects(state: RunState): Promise<void> {
  const records: Project[] = [];
  for await (const row of takeRows(state, 'projects')) {
    const legacyId = numericId(row, 'ID');
    if (legacyId !== null && state.existing.projects.has(legacyId)) {
      state.entities.projects!.skipped++;
      const existing = state.existing.projects.get(legacyId)!;
      state.idMaps.projectByLegacy.set(legacyId, existing.id);
      state.idMaps.projectSlugByLegacy.set(legacyId, existing.slug);
      const used = state.idMaps.usedSlugs.get('projects') ?? new Set<string>();
      used.add(existing.slug);
      state.idMaps.usedSlugs.set('projects', used);
      continue;
    }
    const r = safeRun(state, 'projects', () => translateProject(row, ctxFor(state)));
    if (!r) continue;
    const parsed = parseOrSkip(state, 'projects', () => ProjectSchema.parse(r));
    if (parsed) {
      records.push(parsed);
      state.entities.projects!.imported++;
    }
  }

  await commit(state, 'projects', `${records.length} projects`, async (tx) => {
    const sheet = tx.sheet('projects');
    for (const r of records) await sheet.upsert(r as unknown as Record<string, unknown>);
  });
}

interface MembershipWritable {
  readonly record: ProjectMembership;
  readonly pathFields: { projectSlug: string; personSlug: string };
}

async function importMemberships(state: RunState): Promise<void> {
  const records: MembershipWritable[] = [];
  for await (const row of takeRows(state, 'project_members')) {
    const r = safeRun(state, 'project-memberships', () =>
      translateMembership(row, ctxFor(state)),
    );
    if (!r) continue;
    const compositeKey = `${r.pathFields.projectSlug}/${r.pathFields.personSlug}`;
    if (state.existing.membershipPaths.has(compositeKey)) {
      state.entities['project-memberships']!.skipped++;
      continue;
    }
    const parsed = parseOrSkip(state, 'project-memberships', () =>
      ProjectMembershipSchema.parse(r.membership),
    );
    if (parsed) {
      records.push({ record: parsed, pathFields: r.pathFields });
      state.entities['project-memberships']!.imported++;
    }
  }

  await commit(
    state,
    'project-memberships',
    `${records.length} project-memberships`,
    async (tx) => {
      const sheet = tx.sheet('project-memberships');
      for (const { record, pathFields } of records) {
        await sheet.upsert({ ...record, ...pathFields } as unknown as Record<string, unknown>);
      }
    },
  );
}

interface UpdateWritable {
  readonly record: ProjectUpdate;
  readonly pathFields: { projectSlug: string };
}

async function importProjectUpdates(state: RunState): Promise<void> {
  const records: UpdateWritable[] = [];
  for await (const row of takeRows(state, 'project_updates')) {
    const legacyId = numericId(row, 'ID');
    if (legacyId !== null && state.existing.projectUpdates.has(legacyId)) {
      state.entities['project-updates']!.skipped++;
      continue;
    }
    const r = safeRun(state, 'project-updates', () => translateUpdate(row, ctxFor(state)));
    if (!r) continue;
    const parsed = parseOrSkip(state, 'project-updates', () =>
      ProjectUpdateSchema.parse(r.update),
    );
    if (parsed) {
      records.push({ record: parsed, pathFields: r.pathFields });
      state.entities['project-updates']!.imported++;
    }
  }

  await commit(
    state,
    'project-updates',
    `${records.length} project-updates`,
    async (tx) => {
      const sheet = tx.sheet('project-updates');
      for (const { record, pathFields } of records) {
        await sheet.upsert({ ...record, ...pathFields } as unknown as Record<string, unknown>);
      }
    },
  );
}

interface BuzzWritable {
  readonly record: ProjectBuzz;
  readonly pathFields: { projectSlug: string };
}

async function importProjectBuzz(state: RunState): Promise<void> {
  const records: BuzzWritable[] = [];
  for await (const row of takeRows(state, 'project_buzz')) {
    const legacyId = numericId(row, 'ID');
    if (legacyId !== null && state.existing.projectBuzz.has(legacyId)) {
      state.entities['project-buzz']!.skipped++;
      continue;
    }
    const r = safeRun(state, 'project-buzz', () => translateBuzz(row, ctxFor(state)));
    if (!r) continue;
    const parsed = parseOrSkip(state, 'project-buzz', () => ProjectBuzzSchema.parse(r.buzz));
    if (parsed) {
      records.push({ record: parsed, pathFields: r.pathFields });
      state.entities['project-buzz']!.imported++;
    }
  }

  await commit(state, 'project-buzz', `${records.length} project-buzz`, async (tx) => {
    const sheet = tx.sheet('project-buzz');
    for (const { record, pathFields } of records) {
      await sheet.upsert({ ...record, ...pathFields } as unknown as Record<string, unknown>);
    }
  });
}

async function importTagAssignments(state: RunState): Promise<void> {
  const records: TagAssignment[] = [];
  for await (const row of takeRows(state, 'tag_items')) {
    const r = safeRun(state, 'tag-assignments', () =>
      translateTagAssignment(row, ctxFor(state)),
    );
    if (!r) continue;
    const compositeKey = `${r.tagId}/${r.taggableType}/${r.taggableId}`;
    if (state.existing.tagAssignmentPaths.has(compositeKey)) {
      state.entities['tag-assignments']!.skipped++;
      continue;
    }
    const parsed = parseOrSkip(state, 'tag-assignments', () =>
      TagAssignmentSchema.parse(r),
    );
    if (parsed) {
      records.push(parsed);
      state.entities['tag-assignments']!.imported++;
    }
  }

  await commit(
    state,
    'tag-assignments',
    `${records.length} tag-assignments`,
    async (tx) => {
      const sheet = tx.sheet('tag-assignments');
      for (const r of records) await sheet.upsert(r as unknown as Record<string, unknown>);
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blank(): EntityReport {
  return { input: 0, imported: 0, skipped: 0, errors: 0 };
}

function ctxFor(state: RunState): {
  idMaps: IdMaps;
  warnings: Warnings;
  now: string;
} {
  return { idMaps: state.idMaps, warnings: state.warnings, now: state.now };
}

async function* takeRows(state: RunState, table: string): AsyncGenerator<Row> {
  const limit = state.opts.limit ?? Infinity;
  let yielded = 0;
  for await (const row of streamRows(state.opts.sql, table)) {
    // The "input" tally counts rows seen pre-limit so dry-run reports
    // reflect dump size accurately, not just what was imported.
    state.entities[sheetNameForTable(table)]!.input++;
    if (yielded >= limit) continue;
    yielded++;
    yield row;
  }
}

function sheetNameForTable(table: string): string {
  switch (table) {
    case 'people': return 'people';
    case 'projects': return 'projects';
    case 'project_members': return 'project-memberships';
    case 'project_updates': return 'project-updates';
    case 'project_buzz': return 'project-buzz';
    case 'tags': return 'tags';
    case 'tag_items': return 'tag-assignments';
    default: throw new Error(`unhandled table ${table}`);
  }
}

function numericId(row: Row, key: string): number | null {
  const v = row[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function safeRun<T>(state: RunState, sheet: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    state.entities[sheet]!.errors++;
    state.warnings.push(`[${sheet}] translator threw: ${describe(err)}`);
    return null;
  }
}

function parseOrSkip<T>(state: RunState, sheet: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    state.entities[sheet]!.errors++;
    state.warnings.push(`[${sheet}] zod validation failed: ${describe(err)}`);
    return null;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function commit(
  state: RunState,
  sheet: string,
  summary: string,
  // The transaction tx type is opaque here so this module doesn't take on a
  // gitsheets-Transaction generic; the upsert calls are routed through the
  // sheet getter the same way seed-fixtures.ts does.
  fn: (tx: { sheet: (name: string) => { upsert: (r: Record<string, unknown>) => Promise<unknown> } }) => Promise<void>,
): Promise<void> {
  if (state.opts.dryRun) return;
  const repo = await openRepo({
    gitDir: `${state.opts.dataRepo}/.git`,
    workTree: state.opts.dataRepo,
  });
  const result = await repo.transact(
    {
      message: `import: from laddr mysqldump (${sheet})\n\n${summary} imported.`,
      author: { name: AUTHOR_NAME, email: AUTHOR_EMAIL },
      trailers: {
        Action: 'import.laddr',
        'Source-Dump': state.sourceSha256,
        'Run-At': state.now,
      },
    },
    async (tx) => fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  if (result.commitHash) state.commits.push(result.commitHash);
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(filePath);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function collectExistingLegacyIds(dataRepo: string): Promise<ExistingLegacyIds> {
  const out: ExistingLegacyIds = {
    people: new Map(),
    projects: new Map(),
    tags: new Map(),
    projectUpdates: new Set(),
    projectBuzz: new Set(),
    membershipPaths: new Set(),
    tagAssignmentPaths: new Set(),
  };

  // Fresh repo with no HEAD or pre-import HEAD: ls-tree returns empty.
  // Walking git's tree rather than the working dir (gitsheets only updates
  // refs, no checkout) keeps the read aligned with what was committed.
  let listing: string;
  try {
    const { stdout } = await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: dataRepo,
    });
    listing = stdout;
  } catch {
    return out;
  }

  for (const path of listing.split('\n').filter((p) => p.endsWith('.toml'))) {
    // Memberships + tag-assignments live solely by path; cheap to dedupe
    // on path-presence so the second-run skip is trivial.
    if (path.startsWith('project-memberships/')) {
      const stripped = path.slice('project-memberships/'.length, -'.toml'.length);
      out.membershipPaths.add(stripped);
      continue;
    }
    if (path.startsWith('tag-assignments/')) {
      const stripped = path.slice('tag-assignments/'.length, -'.toml'.length);
      out.tagAssignmentPaths.add(stripped);
      continue;
    }

    let mapTarget: { sheet: 'people' | 'projects' | 'tags' | 'updates' | 'buzz' } | null = null;
    if (path.startsWith('people/')) mapTarget = { sheet: 'people' };
    else if (path.startsWith('projects/')) mapTarget = { sheet: 'projects' };
    else if (path.startsWith('tags/')) mapTarget = { sheet: 'tags' };
    else if (path.startsWith('project-updates/')) mapTarget = { sheet: 'updates' };
    else if (path.startsWith('project-buzz/')) mapTarget = { sheet: 'buzz' };
    if (!mapTarget) continue;

    let content: string;
    try {
      content = (
        await exec('git', ['show', `HEAD:${path}`], { cwd: dataRepo })
      ).stdout;
    } catch {
      continue;
    }
    const id = matchToml(content, 'id');
    const slug = matchToml(content, 'slug');
    const legacyIdRaw = matchToml(content, 'legacyId');
    const legacyId = legacyIdRaw !== null ? parseInt(legacyIdRaw, 10) : null;
    if (legacyId === null || Number.isNaN(legacyId)) continue;

    switch (mapTarget.sheet) {
      case 'people':
        if (id && slug) out.people.set(legacyId, { id, slug });
        break;
      case 'projects':
        if (id && slug) out.projects.set(legacyId, { id, slug });
        break;
      case 'tags':
        if (id) out.tags.set(legacyId, id);
        break;
      case 'updates':
        out.projectUpdates.add(legacyId);
        break;
      case 'buzz':
        out.projectBuzz.add(legacyId);
        break;
    }
  }
  return out;
}

function matchToml(content: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm');
  const m = content.match(re);
  if (!m) return null;
  const raw = m[1]!.trim();
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

/**
 * Write legacy-password records to the private store.
 *
 * The PrivateStoreTx interface only exposes profile mutations and legacy-
 * password *deletes* (the runtime only ever drains them, never adds). For
 * the one-shot import we reach past the interface via a duck-typed cast
 * onto the BasePrivateStore's internal `legacyPasswords` Map + flush, the
 * same shape exercised in the store's own tests.
 */
async function writeLegacyPasswords(
  store: PrivateStore,
  records: readonly LegacyPasswordCredential[],
): Promise<void> {
  const internal = store as unknown as {
    legacyPasswords: Map<string, LegacyPasswordCredential>;
    flushLegacyPasswords: () => Promise<void>;
    indices: { legacyPasswordByPersonId: Map<string, LegacyPasswordCredential> };
  };
  for (const r of records) {
    internal.legacyPasswords.set(r.personId, r);
  }
  internal.indices.legacyPasswordByPersonId = internal.legacyPasswords;
  await internal.flushLegacyPasswords();
}
