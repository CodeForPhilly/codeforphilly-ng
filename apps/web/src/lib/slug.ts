/**
 * Slugify a title for use in URLs. Matches the regex
 * `^[a-z0-9][a-z0-9-_]{1,79}$` enforced by the API schemas.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
