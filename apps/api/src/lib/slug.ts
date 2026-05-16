/**
 * Slug helpers per specs/behaviors/slug-handles.md.
 *
 * - Format validators per-entity
 * - slugify() for default generation from display names
 * - Reserved slug list (also enforced here, not just in the Zod schema)
 */

export const RESERVED_SLUGS = new Set<string>([
  'new',
  'create',
  'edit',
  'delete',
  'restore',
  'me',
  'current',
  'self',
  'admin',
  'staff',
  'system',
  'projects',
  'members',
  'people',
  'tags',
  'help-wanted',
  'login',
  'register',
  'logout',
  'api',
  'auth',
]);

/** Reserved-slug check — true if the slug must not be used by user-supplied input. */
export function isReservedSlug(slug: string): boolean {
  if (slug.startsWith('_')) return true;
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-_]{1,79}$/;
const PERSON_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,49}$/;
const TAG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const BUZZ_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,99}$/;

export function isValidProjectSlug(slug: string): boolean {
  return PROJECT_SLUG_RE.test(slug);
}

export function isValidPersonSlug(slug: string): boolean {
  return PERSON_SLUG_RE.test(slug);
}

export function isValidTagSlug(slug: string): boolean {
  return TAG_SLUG_RE.test(slug);
}

export function isValidBuzzSlug(slug: string): boolean {
  return BUZZ_SLUG_RE.test(slug);
}

/**
 * Default slug generator: lowercase, collapse non-[a-z0-9] to hyphens,
 * trim leading/trailing hyphens, truncate to `maxLength`.
 */
export function slugify(input: string, maxLength: number): string {
  const lowered = input.toLowerCase();
  const dashed = lowered.replace(/[^a-z0-9]+/g, '-');
  const trimmed = dashed.replace(/^-+/, '').replace(/-+$/, '');
  if (trimmed.length <= maxLength) return trimmed;
  // Truncate then strip any trailing hyphen from the cut.
  return trimmed.slice(0, maxLength).replace(/-+$/, '');
}

/**
 * Resolve a candidate slug to a unique one by appending `-2`, `-3`, ... until
 * `isTaken(candidate)` returns false. The candidate is presumed valid.
 */
export function ensureUniqueSlug(
  base: string,
  isTaken: (candidate: string) => boolean,
  maxLength: number,
): string {
  if (!isTaken(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const truncated = base.length + suffix.length > maxLength
      ? base.slice(0, maxLength - suffix.length).replace(/-+$/, '')
      : base;
    const candidate = `${truncated}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`Could not find a unique slug for base '${base}'`);
}
