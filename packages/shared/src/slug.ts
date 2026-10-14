/**
 * Legacy handle normalization — specs/behaviors/slug-handles.md →
 * "Legacy handle normalization".
 *
 * The one transform both the laddr importer (to mint slugs) and the web
 * redirect layer (to resolve pre-normalization inbound links) apply, so the
 * two can't drift. Collision suffixing (`-2`, `-3`, …) is the importer's
 * concern and deliberately not part of this.
 */

export type LegacyHandleEntity = 'person' | 'project' | 'tag' | 'buzz';

export interface HandleRules {
  readonly maxLen: number;
  readonly allowUnderscore: boolean;
}

export const LEGACY_HANDLE_RULES: Readonly<Record<LegacyHandleEntity, HandleRules>> = {
  person: { maxLen: 50, allowUnderscore: false },
  project: { maxLen: 80, allowUnderscore: true },
  tag: { maxLen: 50, allowUnderscore: false },
  buzz: { maxLen: 50, allowUnderscore: false },
};

/**
 * Lowercase, replace each run of disallowed characters with `-`, trim
 * leading/trailing `-`/`_`, truncate to `maxLen`, and prefix `s` if the
 * result doesn't start with `[a-z0-9]`. Returns `''` when nothing survives.
 */
export function normalizeHandle(input: string, rules: HandleRules): string {
  const replaceRe = rules.allowUnderscore ? /[^a-z0-9_-]+/g : /[^a-z0-9-]+/g;
  let out = input.toLowerCase().replace(replaceRe, '-');
  out = out.replace(/^[-_]+|[-_]+$/g, '');
  if (out.length === 0) return '';
  if (out.length > rules.maxLen) out = out.slice(0, rules.maxLen);
  if (!/^[a-z0-9]/.test(out)) out = `s${out}`.slice(0, rules.maxLen);
  return out;
}

export function normalizeLegacyHandle(input: string, entity: LegacyHandleEntity): string {
  return normalizeHandle(input, LEGACY_HANDLE_RULES[entity]);
}
