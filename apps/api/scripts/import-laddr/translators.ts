/**
 * Translators: laddr `?format=json` shape → v1 (gitsheets/private)
 *
 * Each translator takes one raw laddr JSON row + a context bag (id maps,
 * warning sink, wall-clock) and returns the target record(s). UUIDs are
 * minted here and remembered in the context maps so subsequent translators
 * can resolve cross-table FKs.
 *
 * The JSON inputs validated by `json-fetcher.ts` already match the shape
 * we read here. Schemas in `@cfp/shared/schemas` are the v1 validation
 * contract; this layer is a pure mapping. Validation happens in the
 * importer after the translator returns, so warnings/errors surface with
 * the row's legacyId attached.
 *
 * Field-mapping source of truth: specs/data-model.md `Naming map: laddr →
 * rewrite` table.
 *
 * Important differences from the previous mysqldump-shape translators:
 *   - Timestamps in JSON are unix epoch seconds (numbers), not
 *     `YYYY-MM-DD HH:MM:SS` strings.
 *   - Tags and memberships arrive embedded on the project record via
 *     `?include=Tags,Memberships`; there is no separate `tag_items`
 *     endpoint, so we synthesize TagAssignment records by iterating each
 *     project's (and person's) embedded Tags array.
 */
import { uuidv7 } from 'uuidv7';

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

import type {
  RawBlogPost,
  RawBlogPostItem,
  RawMembership,
  RawPerson,
  RawProject,
  RawProjectBuzz,
  RawProjectUpdate,
  RawTag,
} from './json-fetcher.js';

export interface Warnings {
  push(warning: string): void;
}

export interface IdMaps {
  /** laddr Person.ID → v1 Person.id (uuid) */
  readonly personByLegacy: Map<number, string>;
  /** laddr Person.ID → v1 Person.slug (for path-template fields on membership) */
  readonly personSlugByLegacy: Map<number, string>;
  /** laddr Project.ID → v1 Project.id (uuid) */
  readonly projectByLegacy: Map<number, string>;
  /** laddr Project.ID → v1 Project.slug (for path-template fields) */
  readonly projectSlugByLegacy: Map<number, string>;
  /** laddr Tag.ID → v1 Tag.id (uuid) */
  readonly tagByLegacy: Map<number, string>;
  /** v1 Project.id → number generator for ProjectUpdate.number */
  readonly nextUpdateNumberByProjectId: Map<string, number>;
  /** used slugs per entity sheet for dedupe (`'people' → Set<slug>`) */
  readonly usedSlugs: Map<string, Set<string>>;
}

export function newIdMaps(): IdMaps {
  return {
    personByLegacy: new Map(),
    personSlugByLegacy: new Map(),
    projectByLegacy: new Map(),
    projectSlugByLegacy: new Map(),
    tagByLegacy: new Map(),
    nextUpdateNumberByProjectId: new Map(),
    usedSlugs: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Cell readers
// ---------------------------------------------------------------------------

function nonEmptyStr(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * Convert a unix epoch seconds value (laddr's JSON timestamp shape) into
 * an ISO 8601 UTC string. Returns null when input is null/undefined or
 * obviously invalid.
 */
function epochToIso(v: number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return new Date(v * 1000).toISOString();
}

function epochToIsoOr(v: number | null | undefined, fallback: string): string {
  return epochToIso(v) ?? fallback;
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

function normalizeStage(
  raw: string | null,
  warnings: Warnings,
  legacyId: number,
): Stage {
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

/**
 * Split a laddr tag handle (`topic.transit`) into our namespace + slug. The
 * laddr JSON output occasionally returns handles with the period stripped
 * (`topictransit`); when the source row has a `Title` like `topic.Transit`
 * we recover the namespace from there. Both Handle and the slug component
 * are lowercased; slug-shape normalization happens at the call site.
 *
 * When neither Handle nor Title supplies a `topic.`/`tech.`/`event.` prefix
 * (~12% of laddr tags — these were created via autocomplete-create without
 * typing a namespace), we default to `topic` rather than skip. An audit
 * warning is emitted so operators can re-namespace them later via tooling.
 * Per specs/data-model.md#tag.
 */
export function splitTagHandle(
  handle: string,
  title: string | null,
  warnings: Warnings,
  legacyId: number,
): { namespace: Namespace; slug: string } {
  const tryFrom = (s: string): { namespace: Namespace; slug: string } | null => {
    const dotIdx = s.indexOf('.');
    if (dotIdx === -1) return null;
    const ns = s.slice(0, dotIdx).toLowerCase();
    const slug = s.slice(dotIdx + 1).toLowerCase();
    if (!(VALID_NAMESPACES as readonly string[]).includes(ns)) return null;
    if (slug.length === 0) return null;
    return { namespace: ns as Namespace, slug };
  };

  const fromHandle = tryFrom(handle);
  if (fromHandle) return fromHandle;
  const fromTitle = title ? tryFrom(title) : null;
  if (fromTitle) {
    warnings.push(
      `[tags] legacyId=${legacyId} handle "${handle}" had no namespace; recovered "${fromTitle.namespace}.${fromTitle.slug}" from title`,
    );
    return fromTitle;
  }
  warnings.push(
    `[tags] legacyId=${legacyId} handle "${handle}" has no resolvable namespace; defaulted to topic`,
  );
  return { namespace: 'topic', slug: handle.toLowerCase() };
}

// ---------------------------------------------------------------------------
// AccountLevel mapping
// ---------------------------------------------------------------------------

function mapAccountLevel(raw: string): 'user' | 'staff' | 'administrator' {
  const lower = raw.toLowerCase();
  if (lower === 'administrator' || lower === 'developer') return 'administrator';
  if (lower === 'staff' || lower === 'editor' || lower === 'manager') return 'staff';
  return 'user';
}

// ---------------------------------------------------------------------------
// HTTPS-URL validator
// ---------------------------------------------------------------------------

function validHttps(s: string | null): string | null {
  if (s === null) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function validUrl(s: string | null): string | null {
  if (s === null) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Coerce a freeform chat-channel string (laddr returns things like
 * `Benefit-Decision-Toolkit` or `#general` or `food.access`) into the v1
 * regex `^[a-z0-9][a-z0-9_-]{0,40}$`. Returns null if no usable form can be
 * derived.
 */
function normalizeChatChannel(raw: string | null): string | null {
  if (raw === null) return null;
  const stripped = raw.replace(/^#+/, '').toLowerCase();
  const cleaned = stripped.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length === 0) return null;
  if (!/^[a-z0-9]/.test(cleaned)) return null;
  return cleaned.slice(0, 41); // schema bounds: head + up to 40 trailing chars
}

// ---------------------------------------------------------------------------
// Translators
// ---------------------------------------------------------------------------

/**
 * Existing UUIDs read from the previous snapshot, keyed by `<sheet>/<filename
 * without .toml>`. The translator consults these so re-runs reuse the same
 * `id` for each record, making consecutive snapshots idempotent when the
 * source data hasn't changed.
 */
export interface ExistingIds {
  /** `<sheet>/<filename>` → existing `id` field. */
  readonly byFile: Map<string, string>;
}

export function newExistingIds(): ExistingIds {
  return { byFile: new Map() };
}

export interface TranslateCtx {
  readonly idMaps: IdMaps;
  readonly warnings: Warnings;
  /** Wall clock for `now`-style defaults — kept deterministic in tests. */
  readonly now: string;
  /** Carry-forward UUIDs from the previous snapshot. */
  readonly existingIds: ExistingIds;
}

/** Mint a fresh UUIDv7 or reuse the one we already wrote for this file. */
function idFor(ctx: TranslateCtx, filePath: string): string {
  const existing = ctx.existingIds.byFile.get(filePath);
  if (existing) return existing;
  return uuidv7();
}

export function translatePerson(row: RawPerson, ctx: TranslateCtx): Person {
  const legacyId = row.ID;
  const username = nonEmptyStr(row.Username) ?? `legacy-${legacyId}`;
  const slug = safeSlug(username, 'people', 50, false, {
    idMaps: ctx.idMaps,
    warnings: ctx.warnings,
    legacyId,
  });

  const id = idFor(ctx, `people/${legacyId}`);
  ctx.idMaps.personByLegacy.set(legacyId, id);
  ctx.idMaps.personSlugByLegacy.set(legacyId, slug);

  const firstName = nonEmptyStr(row.FirstName);
  const lastName = nonEmptyStr(row.LastName);
  const computedName = [firstName, lastName].filter((s) => s !== null).join(' ').trim();
  const fullNameRaw =
    nonEmptyStr(row.PreferredName) ??
    (computedName.length > 0 ? computedName : username);
  // Schema caps fullName at 120 chars — silently truncate longer names.
  const fullName = fullNameRaw.length > 120 ? fullNameRaw.slice(0, 120) : fullNameRaw;
  if (fullName !== fullNameRaw) {
    ctx.warnings.push(
      `[people] legacyId=${legacyId} fullName truncated from ${fullNameRaw.length} to 120 chars`,
    );
  }

  const accountLevel = mapAccountLevel(nonEmptyStr(row.AccountLevel) ?? 'User');

  const createdAt = epochToIsoOr(row.Created, ctx.now);
  const updatedAt = epochToIsoOr(row.Modified, createdAt);

  // Bio is capped at 10,000 chars in the Zod schema. Laddr's About is
  // freeform and has been weaponized by spam accounts — silently truncate
  // and surface a warning so the source row is traceable.
  let bio: string | undefined;
  const rawBio = nonEmptyStr(row.About);
  if (rawBio !== null) {
    if (rawBio.length > 10_000) {
      ctx.warnings.push(
        `[people] legacyId=${legacyId} bio truncated from ${rawBio.length} to 10000 chars`,
      );
      bio = rawBio.slice(0, 10_000);
    } else {
      bio = rawBio;
    }
  }

  const person: Person = {
    id,
    legacyId,
    slug,
    fullName,
    ...(firstName !== null ? { firstName } : {}),
    ...(lastName !== null ? { lastName } : {}),
    ...(bio !== undefined ? { bio } : {}),
    accountLevel,
    slackSamlNameId: slug,
    createdAt,
    updatedAt,
  };

  return person;
}

export function translateProject(row: RawProject, ctx: TranslateCtx): Project {
  const legacyId = row.ID;
  const handle = nonEmptyStr(row.Handle) ?? `legacy-${legacyId}`;
  const slug = safeSlug(handle, 'projects', 80, true, {
    idMaps: ctx.idMaps,
    warnings: ctx.warnings,
    legacyId,
  });

  const id = idFor(ctx, `projects/${legacyId}`);
  ctx.idMaps.projectByLegacy.set(legacyId, id);
  ctx.idMaps.projectSlugByLegacy.set(legacyId, slug);

  const createdAt = epochToIsoOr(row.Created, ctx.now);
  const updatedAt = epochToIsoOr(row.Modified, createdAt);

  const maintainerLegacy =
    typeof row.MaintainerID === 'number' ? row.MaintainerID : null;
  const maintainerId =
    maintainerLegacy !== null ? ctx.idMaps.personByLegacy.get(maintainerLegacy) ?? null : null;
  if (maintainerLegacy !== null && maintainerId === null) {
    ctx.warnings.push(
      `[projects] legacyId=${legacyId} MaintainerID=${maintainerLegacy} not found among imported people`,
    );
  }

  const titleRaw = nonEmptyStr(row.Title) ?? slug;
  const title = titleRaw.length > 200 ? titleRaw.slice(0, 200) : titleRaw;
  if (title !== titleRaw) {
    ctx.warnings.push(
      `[projects] legacyId=${legacyId} title truncated from ${titleRaw.length} to 200 chars`,
    );
  }

  return {
    id,
    legacyId,
    slug,
    title,
    overview: nonEmptyStr(row.README) ?? undefined,
    stage: normalizeStage(nonEmptyStr(row.Stage), ctx.warnings, legacyId),
    maintainerId: maintainerId ?? undefined,
    usersUrl: validHttps(nonEmptyStr(row.UsersUrl)) ?? undefined,
    developersUrl: validHttps(nonEmptyStr(row.DevelopersUrl)) ?? undefined,
    chatChannel: normalizeChatChannel(nonEmptyStr(row.ChatChannel)) ?? undefined,
    featured: false,
    createdAt,
    updatedAt,
  };
}

export function translateTag(row: RawTag, ctx: TranslateCtx): Tag | null {
  const legacyId = row.ID;
  const handle = nonEmptyStr(row.Handle);
  if (!handle) {
    ctx.warnings.push(`[tags] legacyId=${legacyId} has empty handle; skipped`);
    return null;
  }
  const split = splitTagHandle(handle, nonEmptyStr(row.Title), ctx.warnings, legacyId);

  // The slug component derived from a handle like `topic.urban_design` can
  // contain underscores. Tag slugs only allow `[a-z0-9-]` — coerce, but
  // don't dedupe (tags are uniqued by `(namespace, slug)` already; collisions
  // surface as gitsheets-side write errors and are exceedingly rare).
  const slug = split.slug.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length === 0) {
    ctx.warnings.push(
      `[tags] legacyId=${legacyId} slug "${split.slug}" reduced to empty after sanitization; skipped`,
    );
    return null;
  }

  const id = idFor(ctx, `tags/${legacyId}`);
  ctx.idMaps.tagByLegacy.set(legacyId, id);

  const createdAt = epochToIsoOr(row.Created, ctx.now);
  // Tags in laddr have no Modified column; use Created.
  const updatedAt = createdAt;

  return {
    id,
    legacyId,
    namespace: split.namespace,
    slug,
    title: nonEmptyStr(row.Title) ?? slug,
    createdAt,
    updatedAt,
  };
}

export interface MembershipResult {
  readonly membership: ProjectMembership;
  /** legacyId pair for stable filename derivation on the legacy-import branch. */
  readonly legacyIds: { projectLegacyId: number; personLegacyId: number };
}

/**
 * Translate a project-membership row. `projectMaintainerLegacyId` is the
 * project's `MaintainerID` so we can denormalize `isMaintainer` per the data
 * model (`ProjectMembership.isMaintainer == (Project.maintainerId == personId)`).
 */
export function translateMembership(
  row: RawMembership,
  projectMaintainerLegacyId: number | null,
  ctx: TranslateCtx,
): MembershipResult | null {
  const projectLegacyId = row.ProjectID;
  const personLegacyId = row.MemberID;
  const projectId = ctx.idMaps.projectByLegacy.get(projectLegacyId);
  const personId = ctx.idMaps.personByLegacy.get(personLegacyId);
  if (!projectId || !personId) {
    ctx.warnings.push(
      `[project-memberships] project=${projectLegacyId} person=${personLegacyId} — unresolved FK; skipped`,
    );
    return null;
  }

  const joinedAt = epochToIsoOr(row.Created, ctx.now);
  const role = nonEmptyStr(row.Role);
  const isMaintainer = projectMaintainerLegacyId === personLegacyId;

  return {
    membership: {
      id: idFor(ctx, `project-memberships/${projectLegacyId}-${personLegacyId}`),
      projectId,
      personId,
      role: role ?? undefined,
      isMaintainer,
      joinedAt,
      createdAt: joinedAt,
      updatedAt: joinedAt,
    },
    legacyIds: { projectLegacyId, personLegacyId },
  };
}

export interface UpdateResult {
  readonly update: ProjectUpdate;
  readonly projectLegacyId: number;
}

export function translateUpdate(
  row: RawProjectUpdate,
  ctx: TranslateCtx,
): UpdateResult | null {
  const legacyId = row.ID;
  const projectLegacyId = row.ProjectID;
  const projectId = ctx.idMaps.projectByLegacy.get(projectLegacyId);
  if (!projectId) {
    ctx.warnings.push(
      `[project-updates] legacyId=${legacyId} project=${projectLegacyId} — unresolved FK; skipped`,
    );
    return null;
  }

  // Laddr provides a per-project Number directly; preserve it where present,
  // otherwise fall back to a synthesized sequence (we still track our own
  // counter in case Number is missing).
  const next = (ctx.idMaps.nextUpdateNumberByProjectId.get(projectId) ?? 0) + 1;
  ctx.idMaps.nextUpdateNumberByProjectId.set(projectId, next);
  const number = typeof row.Number === 'number' && row.Number > 0 ? row.Number : next;

  const authorLegacyId = typeof row.CreatorID === 'number' ? row.CreatorID : null;
  const authorId =
    authorLegacyId !== null ? ctx.idMaps.personByLegacy.get(authorLegacyId) ?? null : null;

  const createdAt = epochToIsoOr(row.Created, ctx.now);
  const updatedAt = epochToIsoOr(row.Modified, createdAt);

  return {
    update: {
      id: idFor(ctx, `project-updates/${legacyId}`),
      legacyId,
      projectId,
      authorId: authorId ?? undefined,
      body: nonEmptyStr(row.Body) ?? '(no body)',
      number,
      createdAt,
      updatedAt,
    },
    projectLegacyId,
  };
}

export interface BuzzResult {
  readonly buzz: ProjectBuzz;
  readonly projectLegacyId: number;
}

export function translateBuzz(
  row: RawProjectBuzz,
  ctx: TranslateCtx,
): BuzzResult | null {
  const legacyId = row.ID;
  const projectLegacyId = row.ProjectID;
  const projectId = ctx.idMaps.projectByLegacy.get(projectLegacyId);
  const projectSlug = ctx.idMaps.projectSlugByLegacy.get(projectLegacyId);
  if (!projectId || !projectSlug) {
    ctx.warnings.push(
      `[project-buzz] legacyId=${legacyId} project=${projectLegacyId} — unresolved FK; skipped`,
    );
    return null;
  }
  const url = validUrl(nonEmptyStr(row.URL));
  if (!url) {
    ctx.warnings.push(
      `[project-buzz] legacyId=${legacyId} missing/invalid URL; skipped`,
    );
    return null;
  }

  const headline = nonEmptyStr(row.Headline) ?? `buzz-${legacyId}`;
  const slug = safeSlug(headline, `project-buzz:${projectSlug}`, 50, false, {
    idMaps: ctx.idMaps,
    warnings: ctx.warnings,
    legacyId,
  });

  const postedByLegacy = typeof row.CreatorID === 'number' ? row.CreatorID : null;
  const postedById =
    postedByLegacy !== null ? ctx.idMaps.personByLegacy.get(postedByLegacy) ?? null : null;

  const createdAt = epochToIsoOr(row.Created, ctx.now);
  const publishedAt = epochToIsoOr(row.Published, createdAt);
  const updatedAt = epochToIsoOr(row.Modified, createdAt);

  return {
    buzz: {
      id: idFor(ctx, `project-buzz/${legacyId}`),
      legacyId,
      projectId,
      postedById: postedById ?? undefined,
      slug,
      headline,
      url,
      publishedAt,
      summary: nonEmptyStr(row.Summary) ?? undefined,
      createdAt,
      updatedAt,
    },
    projectLegacyId,
  };
}

/**
 * Source host used for legacy media URLs in blog bodies. Items of class
 * `Emergence\CMS\Item\Media` reference a numeric `MediaID`. The importer
 * fetches the **original** bytes from `https://<host>/media/<id>/original`
 * at import time and stores them as gitsheets attachments scoped to the
 * owning blog post. Runtime resizing (so a thumbnail card doesn't pull
 * the full original) is tracked separately in
 * https://github.com/CodeForPhilly/codeforphilly-ng/issues/108.
 */
const LADDR_MEDIA_HOST = 'codeforphilly.org';

/**
 * Build the legacy laddr URL to fetch a media item's original bytes.
 * Exported for the importer's pre-fetch phase.
 */
export function laddrMediaUrl(mediaId: number): string {
  return `https://${LADDR_MEDIA_HOST}/media/${mediaId}/original`;
}

/**
 * Sentinel placeholder format embedded in the markdown body at translate
 * time. The importer's pre-fetch phase replaces each placeholder with the
 * final `/api/attachments/blog-posts/<slug>/<filename>` URL once it knows
 * the file extension (derived from the response Content-Type).
 *
 * Placeholder form: `cfp-media:<MediaID>`. Used as a URL substring inside
 * `![](...)` markdown image syntax and inside Embed HTML `src` attributes.
 */
export function mediaPlaceholderUrl(mediaId: number): string {
  return `cfp-media:${mediaId}`;
}

/**
 * Slugify a string for use as a filename component. Simpler than `safeSlug` —
 * no collision tracking, no warning side-effects; the call sites disambiguate
 * via the MediaID suffix.
 */
function slugifyForFilename(input: string, maxLen = 80): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned.length === 0) return 'image';
  return cleaned.slice(0, maxLen).replace(/-+$/, '');
}

export interface BlogMediaAsset {
  /** laddr's numeric MediaID. */
  readonly mediaId: number;
  /** Caption slug component (without the `-<mediaId>` suffix or extension). */
  readonly captionSlug: string;
  /** Owning post's slug — determines the attachment subdirectory. */
  readonly ownerSlug: string;
  /** Where to fetch the original bytes from. */
  readonly sourceUrl: string;
}

/**
 * Scan an Embed item's raw HTML for legacy laddr media URLs and rewrite
 * them inline to use the placeholder. Returns the rewritten HTML plus a
 * list of asset descriptors discovered. Third-party URLs (YouTube iframes,
 * external links) are left alone.
 *
 * URL pattern matched: `https?://codeforphilly.org/(thumbnail|media)/<id>/...`
 * up to the first whitespace, `"`, `'`, `<`, or `)`. The MediaID is the
 * capture group used to dedupe and key the asset; the path tail after the
 * ID is discarded since we always fetch via `/media/<id>/original`.
 */
function rewriteEmbedHtml(
  html: string,
  ownerSlug: string,
  collected: Map<number, BlogMediaAsset>,
): string {
  const re = /https?:\/\/codeforphilly\.org\/(?:thumbnail|media)\/(\d+)\/[^"'<\s)]+/g;
  return html.replace(re, (_full, idStr: string) => {
    const mediaId = Number(idStr);
    if (!Number.isFinite(mediaId)) return _full;
    if (!collected.has(mediaId)) {
      collected.set(mediaId, {
        mediaId,
        captionSlug: 'image',
        ownerSlug,
        sourceUrl: laddrMediaUrl(mediaId),
      });
    }
    return mediaPlaceholderUrl(mediaId);
  });
}

/**
 * Assemble a blog post's markdown body from laddr's typed `items` array.
 * Items are sorted by `Order` (defensive — laddr's JSON tends to come
 * pre-sorted, but the contract isn't documented).
 *
 * Three item classes appear in production:
 *   - `Emergence\CMS\Item\Markdown` — `Data` is the raw markdown string;
 *     append verbatim.
 *   - `Emergence\CMS\Item\Media` — `Data` is `{ MediaID, Caption }`;
 *     render as a markdown image with a placeholder URL that the
 *     importer's pre-fetch phase will resolve to a final
 *     `/api/attachments/blog-posts/<slug>/<filename>` URL.
 *   - `Emergence\CMS\Item\Embed` — `Data` is raw HTML (iframes, divs).
 *     Append as a raw HTML block (legal in CommonMark); embedded
 *     references to codeforphilly.org media URLs get rewritten to
 *     placeholders inline.
 *
 * Returns the assembled body plus a deduped map of discovered media
 * assets — same MediaID referenced twice (e.g., in two embeds) becomes
 * one attachment.
 */
function assembleBlogBody(
  items: readonly RawBlogPostItem[] | undefined,
  warnings: Warnings,
  legacyId: number,
  ownerSlug: string,
): { body: string; mediaAssets: BlogMediaAsset[] } {
  if (!items || items.length === 0) return { body: '', mediaAssets: [] };
  const sorted = [...items].sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0));
  const blocks: string[] = [];
  const collected = new Map<number, BlogMediaAsset>();
  for (const item of sorted) {
    if (item.Class.endsWith('Item\\Markdown')) {
      if (typeof item.Data === 'string') {
        blocks.push(item.Data);
      }
    } else if (item.Class.endsWith('Item\\Media')) {
      const data = item.Data;
      if (data && typeof data === 'object' && 'MediaID' in data) {
        const mediaId = (data as { MediaID?: unknown }).MediaID;
        const caption = (data as { Caption?: unknown }).Caption;
        const captionText =
          typeof caption === 'string' && caption.trim().length > 0 ? caption.trim() : '';
        if (typeof mediaId === 'number') {
          // Captioned items keep their caption in the slug component;
          // un-captioned items fall back to "image". A subsequent
          // reference to the same MediaID (rare) keeps the first
          // caption seen.
          if (!collected.has(mediaId)) {
            collected.set(mediaId, {
              mediaId,
              captionSlug:
                captionText.length > 0 ? slugifyForFilename(captionText) : 'image',
              ownerSlug,
              sourceUrl: laddrMediaUrl(mediaId),
            });
          }
          const url = mediaPlaceholderUrl(mediaId);
          blocks.push(`![${captionText}](${url})`);
        }
      }
    } else if (item.Class.endsWith('Item\\Embed')) {
      if (typeof item.Data === 'string' && item.Data.trim().length > 0) {
        // Rewrite legacy media URLs in the HTML to placeholders; third-
        // party URLs (YouTube iframes etc.) pass through untouched.
        const rewritten = rewriteEmbedHtml(item.Data, ownerSlug, collected);
        blocks.push(rewritten);
      }
    } else {
      warnings.push(
        `[blog-posts] legacyId=${legacyId} item=${item.ID} unknown Class ${JSON.stringify(item.Class)}; skipped`,
      );
    }
  }
  return {
    body: blocks.join('\n\n'),
    mediaAssets: [...collected.values()],
  };
}

export interface BlogPostTranslation {
  /** The validated record (still has placeholder URLs in `.body`). */
  readonly record: BlogPost;
  /**
   * Media assets the importer needs to fetch + commit as attachments.
   * Each item's `mediaId` corresponds to a `cfp-media:<mediaId>`
   * placeholder occurrence in `record.body`.
   */
  readonly mediaAssets: readonly BlogMediaAsset[];
}

/**
 * Translate a laddr `BlogPost` row into a v1 `BlogPost` record plus a
 * media-asset plan.
 *
 * Slug source priority: `Handle` (laddr's URL-safe identifier) →
 * slugified `Title` → `legacy-<ID>`. Bodies are assembled from the row's
 * `items` array via `assembleBlogBody` — media references emit
 * placeholder URLs (`cfp-media:<mediaId>`) that the importer resolves
 * after fetching the bytes. `AuthorID` resolves via the people-by-legacy
 * map; an unresolved author is recorded as a warning but doesn't block
 * the post (runtime treats `authorId === null` as anonymous).
 */
export function translateBlogPost(
  row: RawBlogPost,
  ctx: TranslateCtx,
): BlogPostTranslation | null {
  const legacyId = row.ID;

  const handle = nonEmptyStr(row.Handle);
  const title = nonEmptyStr(row.Title) ?? `Untitled Post #${legacyId}`;
  const slugSource = handle ?? title;
  const slug = safeSlug(slugSource, 'blog-posts', 100, false, {
    idMaps: ctx.idMaps,
    warnings: ctx.warnings,
    legacyId,
  });

  const id = idFor(ctx, `blog-posts/${legacyId}`);

  const authorLegacy = typeof row.AuthorID === 'number' ? row.AuthorID : null;
  const authorId =
    authorLegacy !== null ? ctx.idMaps.personByLegacy.get(authorLegacy) ?? null : null;
  if (authorLegacy !== null && authorId === null) {
    ctx.warnings.push(
      `[blog-posts] legacyId=${legacyId} author=${authorLegacy} unresolved; posting anonymously`,
    );
  }

  const createdAt = epochToIsoOr(row.Created, ctx.now);
  const updatedAt = epochToIsoOr(row.Modified, createdAt);
  // postedAt prefers laddr's Published timestamp; falls back to Created so
  // posts that lack an explicit publish date still sort sensibly.
  const postedAt = epochToIsoOr(row.Published, createdAt);
  // editedAt only surfaces when Modified is meaningfully after Published
  // (>60s gap) — otherwise it'd duplicate postedAt for every post.
  const editedAt =
    typeof row.Modified === 'number' &&
    typeof row.Published === 'number' &&
    row.Modified - row.Published > 60
      ? epochToIsoOr(row.Modified, createdAt)
      : undefined;

  const { body, mediaAssets } = assembleBlogBody(row.items, ctx.warnings, legacyId, slug);
  const summary = nonEmptyStr(row.Summary);
  // The schema caps summary at 500 chars; truncate longer laddr summaries
  // rather than failing validation on import.
  const truncatedSummary =
    summary === null ? undefined : summary.length > 500 ? summary.slice(0, 497) + '…' : summary;

  const record: BlogPost = {
    id,
    legacyId,
    slug,
    title,
    summary: truncatedSummary,
    authorId: authorId ?? undefined,
    postedAt,
    editedAt,
    body,
    createdAt,
    updatedAt,
  };
  return { record, mediaAssets };
}

export interface TagAssignmentResult {
  readonly assignment: TagAssignment;
  /** Stable filename component (legacy tag id). */
  readonly tagLegacyId: number;
  /** Stable filename component (legacy taggable id). */
  readonly taggableLegacyId: number;
}

/**
 * Synthesize a TagAssignment from an embedded Tag (as returned by laddr's
 * `?include=Tags`) attached to either a project or a person.
 *
 * Laddr's underlying `tag_items` table has its own ID, but the JSON output
 * doesn't surface it — we mint a UUIDv7. The legacy-import branch's
 * filename is derived from the (tagLegacyId, taggableType, taggableLegacyId)
 * triple so re-runs overwrite the same path.
 */
export function translateTagAssignment(
  rawTag: RawTag,
  taggableLegacyId: number,
  taggableType: 'project' | 'person',
  ctx: TranslateCtx,
): TagAssignmentResult | null {
  const tagLegacyId = rawTag.ID;
  const tagId = ctx.idMaps.tagByLegacy.get(tagLegacyId);
  if (!tagId) {
    ctx.warnings.push(
      `[tag-assignments] tag legacyId=${tagLegacyId} not in tag map; skipped`,
    );
    return null;
  }
  const taggableId =
    taggableType === 'project'
      ? ctx.idMaps.projectByLegacy.get(taggableLegacyId)
      : ctx.idMaps.personByLegacy.get(taggableLegacyId);
  if (!taggableId) {
    ctx.warnings.push(
      `[tag-assignments] ${taggableType} legacyId=${taggableLegacyId} unresolved; skipped`,
    );
    return null;
  }

  return {
    assignment: {
      id: idFor(
        ctx,
        `tag-assignments/${tagLegacyId}-${taggableType}-${taggableLegacyId}`,
      ),
      tagId,
      taggableType,
      taggableId,
      createdAt: epochToIsoOr(rawTag.Created, ctx.now),
    },
    tagLegacyId,
    taggableLegacyId,
  };
}
