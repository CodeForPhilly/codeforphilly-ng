/**
 * Translators: laddr (MySQL/Emergence-PHP shape) → v1 (gitsheets/private)
 *
 * Each translator takes one laddr row + a context bag (id maps, ts.id
 * generator, warning sink) and returns the target record(s). UUIDs are
 * minted here and remembered in the context maps so subsequent translators
 * can resolve cross-table FKs.
 *
 * Schemas in `@cfp/shared/schemas` are the validation contract; this layer
 * is a pure mapping. Validation happens in the importer after the translator
 * returns, so warnings/errors surface with the row's legacyId attached.
 *
 * Field-mapping source of truth: specs/data-model.md `Naming map: laddr →
 * rewrite` table.
 */
import { uuidv7 } from 'uuidv7';

import type { Row, SqlValue } from './mysqldump-parser.js';
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

export interface Warnings {
  push(warning: string): void;
}

export interface IdMaps {
  /** laddr Person.ID → v1 Person.id (uuid) */
  readonly personByLegacy: Map<number, string>;
  /** laddr Project.ID → v1 Project.id (uuid) */
  readonly projectByLegacy: Map<number, string>;
  /** laddr Project.ID → v1 Project.slug (for path-template fields) */
  readonly projectSlugByLegacy: Map<number, string>;
  /** laddr Tag.ID → v1 Tag.id (uuid) */
  readonly tagByLegacy: Map<number, string>;
  /** v1 Person.id → v1 Person.slug (for path-template fields on membership) */
  readonly personSlugById: Map<string, string>;
  /** v1 Project.id → number generator for ProjectUpdate.number */
  readonly nextUpdateNumberByProjectId: Map<string, number>;
  /** used slugs per entity sheet for dedupe (`'people' → Set<slug>`) */
  readonly usedSlugs: Map<string, Set<string>>;
}

export function newIdMaps(): IdMaps {
  return {
    personByLegacy: new Map(),
    projectByLegacy: new Map(),
    projectSlugByLegacy: new Map(),
    tagByLegacy: new Map(),
    personSlugById: new Map(),
    nextUpdateNumberByProjectId: new Map(),
    usedSlugs: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Cell readers
// ---------------------------------------------------------------------------

function str(row: Row, key: string): string | null {
  const v: SqlValue = row[key] ?? null;
  if (v === null) return null;
  return typeof v === 'string' ? v : String(v);
}

function nonEmptyStr(row: Row, key: string): string | null {
  const s = str(row, key);
  return s === null || s.length === 0 ? null : s;
}

function int(row: Row, key: string): number | null {
  const v: SqlValue = row[key] ?? null;
  if (v === null) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.trunc(v);
  const n = parseInt(v as string, 10);
  return Number.isNaN(n) ? null : n;
}

function requireInt(row: Row, key: string): number {
  const v = int(row, key);
  if (v === null) throw new Error(`expected integer at column "${key}"`);
  return v;
}

/**
 * Parse a MySQL DATETIME/TIMESTAMP cell into ISO 8601 UTC.
 *
 * laddr dumps timestamps as `YYYY-MM-DD HH:MM:SS` in UTC (no tz suffix).
 * Numeric epoch-seconds also appear in some Emergence schemas.
 */
function toIso(row: Row, key: string): string | null {
  const v: SqlValue = row[key] ?? null;
  if (v === null) return null;
  if (typeof v === 'number') {
    // Emergence sometimes stores Unix timestamps as INT — interpret as seconds
    return new Date(v * 1000).toISOString();
  }
  const s = v as string;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(s)) {
    return new Date(s.replace(' ', 'T') + 'Z').toISOString();
  }
  return null;
}

function toIsoOrDefault(row: Row, key: string, defaultIso: string): string {
  return toIso(row, key) ?? defaultIso;
}

// ---------------------------------------------------------------------------
// Slug normalization
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary string into a v1-valid slug for the given sheet.
 *
 * Two slug regexes are in play:
 *   - person/tag/buzz/slackSamlNameId: `^[a-z0-9][a-z0-9-]{1,49}$`
 *   - project:                        `^[a-z0-9][a-z0-9-_]{1,79}$`
 *
 * Strategy: lowercase, replace runs of non-allowed chars with `-`, trim
 * leading/trailing separators, truncate. If the result collides with a
 * previously-used slug in the same sheet, append `-2`, `-3`, ... until
 * unique. Returns the safe slug and (when changed from input) emits a
 * warning.
 */
export function safeSlug(
  rawInput: string,
  sheet: string,
  maxLen: number,
  allowUnderscore: boolean,
  ctx: { idMaps: IdMaps; warnings: Warnings; legacyId: number | string },
): string {
  const allowedChars = allowUnderscore ? 'a-z0-9-_' : 'a-z0-9-';
  const replaceRe = allowUnderscore ? /[^a-z0-9_-]+/g : /[^a-z0-9-]+/g;
  const headRe = new RegExp(`^[a-z0-9][${allowedChars}]{1,${maxLen - 1}}$`);

  let candidate = rawInput.toLowerCase().replace(replaceRe, '-');
  candidate = candidate.replace(/^[-_]+|[-_]+$/g, '');
  if (candidate.length === 0) candidate = `legacy-${ctx.legacyId}`;
  if (candidate.length > maxLen) candidate = candidate.slice(0, maxLen);
  if (!/^[a-z0-9]/.test(candidate)) candidate = `s${candidate}`.slice(0, maxLen);

  if (candidate !== rawInput) {
    ctx.warnings.push(
      `[${sheet}] legacyId=${ctx.legacyId} slug "${rawInput}" normalized to "${candidate}"`,
    );
  }

  let used = ctx.idMaps.usedSlugs.get(sheet);
  if (!used) {
    used = new Set();
    ctx.idMaps.usedSlugs.set(sheet, used);
  }

  let final = candidate;
  let suffix = 2;
  while (used.has(final)) {
    const tail = `-${suffix}`;
    const base = candidate.slice(0, Math.max(1, maxLen - tail.length));
    final = `${base}${tail}`;
    suffix++;
  }

  if (final !== candidate) {
    ctx.warnings.push(
      `[${sheet}] legacyId=${ctx.legacyId} slug "${candidate}" deduped to "${final}"`,
    );
  }

  used.add(final);

  if (!headRe.test(final)) {
    throw new Error(
      `[${sheet}] could not produce a valid slug from "${rawInput}" (got "${final}")`,
    );
  }

  return final;
}

// ---------------------------------------------------------------------------
// Stage normalization
// ---------------------------------------------------------------------------

const VALID_STAGES = [
  'commenting',
  'bootstrapping',
  'prototyping',
  'testing',
  'maintaining',
  'drifting',
  'hibernating',
] as const;
type Stage = (typeof VALID_STAGES)[number];

function normalizeStage(raw: string | null, warnings: Warnings, legacyId: number): Stage {
  if (raw === null) return 'commenting';
  const lower = raw.toLowerCase();
  if ((VALID_STAGES as readonly string[]).includes(lower)) {
    return lower as Stage;
  }
  warnings.push(
    `[projects] legacyId=${legacyId} stage "${raw}" not recognized; defaulting to "commenting"`,
  );
  return 'commenting';
}

// ---------------------------------------------------------------------------
// Tag handle splitting
// ---------------------------------------------------------------------------

const VALID_NAMESPACES = ['topic', 'tech', 'event'] as const;
type Namespace = (typeof VALID_NAMESPACES)[number];

export function splitTagHandle(
  handle: string,
  warnings: Warnings,
  legacyId: number,
): { namespace: Namespace; slug: string } | null {
  const dotIdx = handle.indexOf('.');
  if (dotIdx === -1) {
    warnings.push(`[tags] legacyId=${legacyId} handle "${handle}" has no namespace; skipped`);
    return null;
  }
  const ns = handle.slice(0, dotIdx).toLowerCase();
  const slug = handle.slice(dotIdx + 1).toLowerCase();
  if (!(VALID_NAMESPACES as readonly string[]).includes(ns)) {
    warnings.push(
      `[tags] legacyId=${legacyId} namespace "${ns}" not one of topic|tech|event; skipped`,
    );
    return null;
  }
  if (slug.length === 0) {
    warnings.push(`[tags] legacyId=${legacyId} empty slug after namespace; skipped`);
    return null;
  }
  return { namespace: ns as Namespace, slug };
}

// ---------------------------------------------------------------------------
// Context taggable type mapping
// ---------------------------------------------------------------------------

/**
 * laddr `tag_items.ContextClass` → v1 `tag-assignments.taggableType`.
 * Returns null for context classes we drop in v1 (e.g. BlogPost).
 */
export function mapContextClass(
  contextClass: string,
  warnings: Warnings,
  legacyId: number,
): 'project' | 'person' | null {
  // Emergence/laddr uses PHP namespace-style class strings.
  if (/Project$/.test(contextClass)) return 'project';
  if (/Person$/.test(contextClass)) return 'person';
  warnings.push(
    `[tag-assignments] legacyId=${legacyId} unsupported ContextClass "${contextClass}"; skipped`,
  );
  return null;
}

// ---------------------------------------------------------------------------
// Translators
// ---------------------------------------------------------------------------

export interface PersonResult {
  /** Public Person record (gitsheets) */
  readonly person: Person;
  /** Private profile (if the person has an email) */
  readonly privateProfile: PrivateProfile | null;
  /** Legacy bcrypt-style password hash (if present) */
  readonly legacyPassword: LegacyPasswordCredential | null;
}

export function translatePerson(
  row: Row,
  ctx: { idMaps: IdMaps; warnings: Warnings; now: string },
): PersonResult {
  const legacyId = requireInt(row, 'ID');
  const username = str(row, 'Username') ?? `legacy-${legacyId}`;
  const slug = safeSlug(username, 'people', 50, false, {
    idMaps: ctx.idMaps,
    warnings: ctx.warnings,
    legacyId,
  });

  const id = uuidv7();
  ctx.idMaps.personByLegacy.set(legacyId, id);
  ctx.idMaps.personSlugById.set(id, slug);

  const firstName = nonEmptyStr(row, 'FirstName');
  const lastName = nonEmptyStr(row, 'LastName');
  const computedName =
    [firstName, lastName].filter((s) => s !== null).join(' ').trim();
  const fullName =
    nonEmptyStr(row, 'FullName') ??
    (computedName.length > 0 ? computedName : username);

  const accountLevelRaw = nonEmptyStr(row, 'AccountLevel') ?? 'User';
  const accountLevel = mapAccountLevel(accountLevelRaw);

  const createdAt = toIsoOrDefault(row, 'Created', ctx.now);
  const updatedAt = toIsoOrDefault(row, 'Modified', createdAt);

  const person: Person = {
    id,
    legacyId,
    slug,
    fullName,
    firstName: firstName ?? undefined,
    lastName: lastName ?? undefined,
    bio: nonEmptyStr(row, 'About') ?? undefined,
    accountLevel,
    slackSamlNameId: slug,
    createdAt,
    updatedAt,
  };

  const email = nonEmptyStr(row, 'Email');
  let privateProfile: PrivateProfile | null = null;
  if (email !== null) {
    privateProfile = {
      personId: id,
      email: email.toLowerCase(),
      emailRefreshedAt: ctx.now,
      updatedAt: ctx.now,
    };
  } else {
    ctx.warnings.push(`[people] legacyId=${legacyId} has no email; no PrivateProfile written`);
  }

  const passwordHash = nonEmptyStr(row, 'Password');
  let legacyPassword: LegacyPasswordCredential | null = null;
  if (passwordHash !== null) {
    legacyPassword = {
      personId: id,
      passwordHash,
      importedAt: ctx.now,
    };
  }

  return { person, privateProfile, legacyPassword };
}

function mapAccountLevel(raw: string): 'user' | 'staff' | 'administrator' {
  const lower = raw.toLowerCase();
  if (lower === 'administrator' || lower === 'developer') return 'administrator';
  if (lower === 'staff' || lower === 'editor' || lower === 'manager') return 'staff';
  return 'user';
}

export function translateProject(
  row: Row,
  ctx: { idMaps: IdMaps; warnings: Warnings; now: string },
): Project {
  const legacyId = requireInt(row, 'ID');
  const handle = str(row, 'Handle') ?? `legacy-${legacyId}`;
  const slug = safeSlug(handle, 'projects', 80, true, {
    idMaps: ctx.idMaps,
    warnings: ctx.warnings,
    legacyId,
  });

  const id = uuidv7();
  ctx.idMaps.projectByLegacy.set(legacyId, id);
  ctx.idMaps.projectSlugByLegacy.set(legacyId, slug);

  const createdAt = toIsoOrDefault(row, 'Created', ctx.now);
  const updatedAt = toIsoOrDefault(row, 'Modified', createdAt);

  const maintainerLegacy = int(row, 'MaintainerID');
  const maintainerId =
    maintainerLegacy !== null ? (ctx.idMaps.personByLegacy.get(maintainerLegacy) ?? null) : null;
  if (maintainerLegacy !== null && maintainerId === null) {
    ctx.warnings.push(
      `[projects] legacyId=${legacyId} MaintainerID=${maintainerLegacy} not found among imported people`,
    );
  }

  return {
    id,
    legacyId,
    slug,
    title: nonEmptyStr(row, 'Title') ?? slug,
    summary: nonEmptyStr(row, 'Summary') ?? undefined,
    overview: nonEmptyStr(row, 'README') ?? undefined,
    stage: normalizeStage(str(row, 'Stage'), ctx.warnings, legacyId),
    maintainerId: maintainerId ?? undefined,
    usersUrl: validHttps(nonEmptyStr(row, 'UsersUrl')) ?? undefined,
    developersUrl: validHttps(nonEmptyStr(row, 'DevelopersUrl')) ?? undefined,
    chatChannel: nonEmptyStr(row, 'ChatChannel') ?? undefined,
    featured: false,
    createdAt,
    updatedAt,
  };
}

function validHttps(s: string | null): string | null {
  if (s === null) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface MembershipResult {
  readonly membership: ProjectMembership;
  /** Path-template fields the storage layer needs but the Zod schema doesn't expose. */
  readonly pathFields: { projectSlug: string; personSlug: string };
}

export function translateMembership(
  row: Row,
  ctx: { idMaps: IdMaps; warnings: Warnings; now: string },
): MembershipResult | null {
  const projectLegacyId = requireInt(row, 'ProjectID');
  const personLegacyId = requireInt(row, 'PersonID');
  const projectId = ctx.idMaps.projectByLegacy.get(projectLegacyId);
  const personId = ctx.idMaps.personByLegacy.get(personLegacyId);
  const projectSlug = ctx.idMaps.projectSlugByLegacy.get(projectLegacyId);
  const personSlug = personId ? ctx.idMaps.personSlugById.get(personId) : undefined;
  if (!projectId || !personId || !projectSlug || !personSlug) {
    ctx.warnings.push(
      `[project-memberships] project=${projectLegacyId} person=${personLegacyId} — unresolved FK; skipped`,
    );
    return null;
  }

  const joinedAt = toIsoOrDefault(row, 'Joined', toIsoOrDefault(row, 'Created', ctx.now));
  const role = nonEmptyStr(row, 'Role');
  const isMaintainer =
    (str(row, 'Role') ?? '').toLowerCase() === 'maintainer' ||
    int(row, 'IsMaintainer') === 1;

  return {
    membership: {
      id: uuidv7(),
      projectId,
      personId,
      role: role ?? undefined,
      isMaintainer,
      joinedAt,
      createdAt: joinedAt,
      updatedAt: joinedAt,
    },
    pathFields: { projectSlug, personSlug },
  };
}

export interface UpdateResult {
  readonly update: ProjectUpdate;
  readonly pathFields: { projectSlug: string };
}

export function translateUpdate(
  row: Row,
  ctx: { idMaps: IdMaps; warnings: Warnings; now: string },
): UpdateResult | null {
  const legacyId = requireInt(row, 'ID');
  const projectLegacyId = requireInt(row, 'ProjectID');
  const projectId = ctx.idMaps.projectByLegacy.get(projectLegacyId);
  const projectSlug = ctx.idMaps.projectSlugByLegacy.get(projectLegacyId);
  if (!projectId || !projectSlug) {
    ctx.warnings.push(
      `[project-updates] legacyId=${legacyId} project=${projectLegacyId} — unresolved FK; skipped`,
    );
    return null;
  }

  const authorLegacyId = int(row, 'AuthorID');
  const authorId =
    authorLegacyId !== null ? (ctx.idMaps.personByLegacy.get(authorLegacyId) ?? null) : null;

  const next = (ctx.idMaps.nextUpdateNumberByProjectId.get(projectId) ?? 0) + 1;
  ctx.idMaps.nextUpdateNumberByProjectId.set(projectId, next);

  const createdAt = toIsoOrDefault(row, 'Created', ctx.now);
  const updatedAt = toIsoOrDefault(row, 'Modified', createdAt);

  return {
    update: {
      id: uuidv7(),
      legacyId,
      projectId,
      authorId: authorId ?? undefined,
      body: nonEmptyStr(row, 'Update') ?? nonEmptyStr(row, 'Body') ?? '(no body)',
      number: next,
      createdAt,
      updatedAt,
    },
    pathFields: { projectSlug },
  };
}

export interface BuzzResult {
  readonly buzz: ProjectBuzz;
  readonly pathFields: { projectSlug: string };
}

export function translateBuzz(
  row: Row,
  ctx: { idMaps: IdMaps; warnings: Warnings; now: string },
): BuzzResult | null {
  const legacyId = requireInt(row, 'ID');
  const projectLegacyId = requireInt(row, 'ProjectID');
  const projectId = ctx.idMaps.projectByLegacy.get(projectLegacyId);
  const projectSlug = ctx.idMaps.projectSlugByLegacy.get(projectLegacyId);
  if (!projectId || !projectSlug) {
    ctx.warnings.push(
      `[project-buzz] legacyId=${legacyId} project=${projectLegacyId} — unresolved FK; skipped`,
    );
    return null;
  }
  const url = validHttps(nonEmptyStr(row, 'URL'));
  if (!url) {
    ctx.warnings.push(
      `[project-buzz] legacyId=${legacyId} missing/invalid URL; skipped`,
    );
    return null;
  }

  const headline = nonEmptyStr(row, 'Headline') ?? `buzz-${legacyId}`;
  const slug = safeSlug(headline, `project-buzz:${projectSlug}`, 50, false, {
    idMaps: ctx.idMaps,
    warnings: ctx.warnings,
    legacyId,
  });

  const postedByLegacy = int(row, 'PostedByID') ?? int(row, 'AuthorID');
  const postedById =
    postedByLegacy !== null ? (ctx.idMaps.personByLegacy.get(postedByLegacy) ?? null) : null;

  const createdAt = toIsoOrDefault(row, 'Created', ctx.now);
  const publishedAt =
    toIso(row, 'Published') ??
    toIso(row, 'PublishedDate') ??
    createdAt;
  const updatedAt = toIsoOrDefault(row, 'Modified', createdAt);

  return {
    buzz: {
      id: uuidv7(),
      legacyId,
      projectId,
      postedById: postedById ?? undefined,
      slug,
      headline,
      url,
      publishedAt,
      summary: nonEmptyStr(row, 'Summary') ?? undefined,
      createdAt,
      updatedAt,
    },
    pathFields: { projectSlug },
  };
}

export function translateTag(
  row: Row,
  ctx: { idMaps: IdMaps; warnings: Warnings; now: string },
): Tag | null {
  const legacyId = requireInt(row, 'ID');
  const handle = nonEmptyStr(row, 'Handle');
  if (!handle) {
    ctx.warnings.push(`[tags] legacyId=${legacyId} has empty handle; skipped`);
    return null;
  }
  const split = splitTagHandle(handle, ctx.warnings, legacyId);
  if (!split) return null;

  const id = uuidv7();
  ctx.idMaps.tagByLegacy.set(legacyId, id);

  const createdAt = toIsoOrDefault(row, 'Created', ctx.now);
  const updatedAt = toIsoOrDefault(row, 'Modified', createdAt);

  return {
    id,
    legacyId,
    namespace: split.namespace,
    slug: split.slug,
    title: nonEmptyStr(row, 'Title') ?? split.slug,
    createdAt,
    updatedAt,
  };
}

export function translateTagAssignment(
  row: Row,
  ctx: { idMaps: IdMaps; warnings: Warnings; now: string },
): TagAssignment | null {
  const legacyId = requireInt(row, 'ID');
  const tagLegacyId = requireInt(row, 'TagID');
  const tagId = ctx.idMaps.tagByLegacy.get(tagLegacyId);
  if (!tagId) {
    ctx.warnings.push(
      `[tag-assignments] legacyId=${legacyId} TagID=${tagLegacyId} not imported; skipped`,
    );
    return null;
  }
  const contextClass = nonEmptyStr(row, 'ContextClass');
  if (!contextClass) {
    ctx.warnings.push(`[tag-assignments] legacyId=${legacyId} missing ContextClass; skipped`);
    return null;
  }
  const taggableType = mapContextClass(contextClass, ctx.warnings, legacyId);
  if (!taggableType) return null;

  const contextLegacyId = requireInt(row, 'ContextID');
  const taggableId =
    taggableType === 'project'
      ? ctx.idMaps.projectByLegacy.get(contextLegacyId)
      : ctx.idMaps.personByLegacy.get(contextLegacyId);
  if (!taggableId) {
    ctx.warnings.push(
      `[tag-assignments] legacyId=${legacyId} ${taggableType} ContextID=${contextLegacyId} not imported; skipped`,
    );
    return null;
  }

  return {
    id: uuidv7(),
    tagId,
    taggableType,
    taggableId,
    createdAt: toIsoOrDefault(row, 'Created', ctx.now),
  };
}
