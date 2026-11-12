/**
 * Checks on an agent's free text bound for a permanent public commit: a purge
 * `reason` (the commit body) and a vote `reasoning` (the commit summary) —
 * specs/api/moderation.md → the purge request, Agent votes. No URL in any
 * form, so the spam link is never republished; no control characters, so a
 * line break cannot forge a commit trailer.
 */

/** Common top-level domains, matched in any case (`Cheap-Pills.SHOP`). */
const COMMON_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'me', 'app', 'dev', 'xyz', 'top', 'shop', 'store', 'online',
  'site', 'club', 'live', 'pro', 'tech', 'link', 'click', 'buzz', 'vip', 'win', 'icu', 'cc', 'tv', 'ru', 'cn',
  'uk', 'us', 'de', 'in', 'ly', 'gg', 'ai', 'to', 'ws', 'su', 'tk', 'ml', 'ga', 'cf', 'gq', 'pw', 'sbs', 'cfd',
  'example',
]);

/** A defanged dot between word characters: `[.]`, `(.)`, `{.}`, `[dot]`, `(dot)`. */
const DEFANGED_DOT = /\w\s*[[({]\s*(?:\.|dot)\s*[\])}]\s*\w/i;
/** Any scheme, `hxxp://` and `hxxps://` included. */
const SCHEME = /\b[a-z][a-z0-9+.-]*:\/\//i;
const WWW = /\bwww\./i;
/**
 * A bare domain: labels joined by dots with a word character on each side of
 * every dot, ending in a TLD of two or more letters. Labels any case; the TLD
 * is checked separately (lowercase, or a common TLD in any case).
 */
const BARE_DOMAIN = /(?<![\w.-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+)([A-Za-z]{2,24})(?![\w-])/g;

/**
 * Whether `text` carries a URL — specs/api/moderation.md → the purge request's
 * `reason`: a scheme (`hxxp://` included), `www.`, a bare domain
 * (`cheap-pills.shop`), or a defanged dot (`promo[.]shop`, `promo(dot)shop`).
 * Ordinary prose (`e.g.`, `spam.Then`, `U.S.`, `2.0`) passes. A purge reason
 * or an agent's vote reasoning is committed forever; it must cite the record,
 * never republish the spam link.
 */
export function containsUrl(text: string): boolean {
  if (SCHEME.test(text) || WWW.test(text) || DEFANGED_DOT.test(text)) return true;
  for (const m of text.matchAll(BARE_DOMAIN)) {
    const labels = m[1]!.slice(0, -1).split('.');
    const tld = m[2]!;
    // `e.g`, `U.S`: single-letter labels throughout are abbreviations.
    if (labels.every((l) => l.length === 1)) continue;
    if (tld === tld.toLowerCase() || COMMON_TLDS.has(tld.toLowerCase())) return true;
  }
  return false;
}

/**
 * Whether `text` holds a control character (a line break included): C0 and
 * C1 controls, DEL, and the Unicode line and paragraph separators.
 */
export function containsControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/**
 * The problem with an agent's free text bound for a public commit (a purge
 * `reason`, a vote `reasoning`), or null: a control character or a URL.
 */
export function agentTextProblem(text: string): string | null {
  if (containsControlChars(text)) return 'must not contain control characters (line breaks included)';
  if (containsUrl(text)) return 'must not contain a URL: cite the record as evidence instead';
  return null;
}
