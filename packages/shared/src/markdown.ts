import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remarkStringify from 'remark-stringify';
import stripMarkdown from 'strip-markdown';
import { unified } from 'unified';

/**
 * Sanitization schema: GitHub-like defaults minus anything dangerous.
 * - No `style` attributes
 * - No `on*` event handlers (excluded by default schema already)
 * - No `javascript:`, `data:`, `file:` URLs (covered by `protocols` entries)
 * - Unknown elements/attributes stripped
 */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Drop `style` from everywhere — not in default schema, but be explicit
    '*': (defaultSchema.attributes?.['*'] ?? []).filter(
      (a) => a !== 'style' && !(Array.isArray(a) && a[0] === 'style'),
    ),
    a: [
      ...(defaultSchema.attributes?.['a'] ?? []),
      'target',
      'rel',
    ],
    img: [
      ...(defaultSchema.attributes?.['img'] ?? []),
      'loading',
      'referrerpolicy',
    ],
    code: ['className'],
  },
  protocols: {
    href: ['http', 'https', 'mailto'],
    src: ['https'],
    longDesc: [],
    cite: [],
  },
  // Disallow all raw HTML passthrough (redundant with remark-rehype allowDangerousHtml: false, but explicit)
  allowComments: false,
};

/**
 * `@mention` resolution (Mdast). Walks text nodes inside any container that
 * permits PhrasingContent (paragraphs, list items, table cells, blockquote
 * paragraphs, …) — by walking only `text` node values we naturally skip
 * `inlineCode` and `code` nodes, which mdast tags distinctly. For each
 * `@<slug>` occurrence where `resolveMention(slug)` returns true, the text
 * node is split and a `link` node is interpolated; unresolved mentions stay
 * as literal text.
 *
 * Slug shape mirrors `Person.slug` (`packages/shared/src/schemas/person.ts`):
 * `[a-z0-9][a-z0-9-]{1,49}`. We require a non-`[a-z0-9]` character (or
 * string-start) immediately before the `@` so emails like `alice@example.com`
 * don't trigger the transform — only true mentions do.
 */
function remarkMentions(opts: { resolveMention: (username: string) => boolean }) {
  const { resolveMention } = opts;
  // Word-start lookbehind via match-at-position helper — JS supports `(?<![a-z0-9])` but
  // we stay portable by walking the string and checking the prior char manually.
  const slugPattern = /@([a-z0-9][a-z0-9-]{1,49})/g;

  return (tree: import('mdast').Root) => {
    visit(tree, undefined);
    function visit(
      node: import('mdast').Nodes,
      parent: { children: import('mdast').Nodes[] } | undefined,
    ) {
      if (parent && node.type === 'text') {
        const replacements = splitTextOnMentions(node.value);
        if (replacements !== null) {
          const idx = parent.children.indexOf(node);
          parent.children.splice(idx, 1, ...replacements);
          return;
        }
      }
      // Walk children. `code` (block) and `inlineCode` have no children that
      // are text/PhrasingContent, so we wouldn't recurse into them anyway —
      // but we explicitly skip to make the intent obvious.
      if (node.type === 'code' || node.type === 'inlineCode') return;
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of [...node.children]) {
          visit(child as import('mdast').Nodes, node as { children: import('mdast').Nodes[] });
        }
      }
    }
  };

  function splitTextOnMentions(value: string): import('mdast').Nodes[] | null {
    slugPattern.lastIndex = 0;
    const out: import('mdast').Nodes[] = [];
    let cursor = 0;
    let matched = false;
    let m: RegExpExecArray | null;
    while ((m = slugPattern.exec(value)) !== null) {
      const at = m.index;
      const slug = m[1] as string;
      // Word-boundary check on the character immediately before `@`.
      const prev = at > 0 ? value.charCodeAt(at - 1) : -1;
      const isWordChar =
        (prev >= 0x30 && prev <= 0x39) || // 0-9
        (prev >= 0x61 && prev <= 0x7a); // a-z (already lowercase per slug rule)
      if (isWordChar) continue;
      if (!resolveMention(slug)) continue;

      matched = true;
      if (at > cursor) {
        out.push({ type: 'text', value: value.slice(cursor, at) });
      }
      out.push({
        type: 'link',
        url: `/members/${slug}`,
        children: [{ type: 'text', value: `@${slug}` }],
      });
      cursor = at + m[0].length;
    }
    if (!matched) return null;
    if (cursor < value.length) {
      out.push({ type: 'text', value: value.slice(cursor) });
    }
    return out;
  }
}

/**
 * External-link transform (HAST). Anchors whose host differs from `siteHost`
 * receive `target="_blank" rel="noopener nofollow"`. Hostless (relative)
 * anchors stay untouched. Runs after sanitization so the rel/target survive
 * the allowlist (the schema's `attributes.a` already permits both).
 *
 * Anchors without an `href`, or with `href` values the URL parser can't
 * interpret, are left alone — they're either malformed or already inert.
 */
function rehypeExternalLinks(opts: { siteHost: string }) {
  const { siteHost } = opts;

  return (tree: import('hast').Root) => {
    visit(tree);
    function visit(node: import('hast').Nodes) {
      if (node.type === 'element' && node.tagName === 'a') {
        const href = node.properties?.href;
        if (typeof href === 'string') {
          const host = hostOf(href);
          if (host !== null && host !== siteHost) {
            node.properties = {
              ...node.properties,
              target: '_blank',
              rel: ['noopener', 'nofollow'],
            };
          }
        }
      }
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) visit(child as import('hast').Nodes);
      }
    }
  };

  /**
   * Returns the host of `href`, or null when there isn't one (relative paths,
   * fragment-only links, mailto: / tel: schemes, …). Protocol-relative
   * (`//other.example/path`) returns the host after the leading `//`.
   *
   * We parse via regex rather than `new URL()` so the package stays free
   * of node/DOM type dependencies for the type-checker — this is a tight
   * subset of URL parsing, but the only thing we need from an anchor's
   * href is whether the host (if any) differs from the site host.
   */
  function hostOf(href: string): string | null {
    // mailto: / tel: / javascript: / data: — no host concept.
    if (/^(mailto|tel|sms|javascript|data|file):/i.test(href)) return null;
    // protocol-relative: //host/path
    if (href.startsWith('//')) {
      const slash = href.indexOf('/', 2);
      return slash === -1 ? href.slice(2) : href.slice(2, slash);
    }
    // absolute: scheme://host/path
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(href);
    if (m) return m[1] || null;
    // anything else (relative path, fragment-only, query-only) → internal
    return null;
  }
}

/**
 * Heading demotion plugin: h1 → h3, h2 → h4, ..., min h6.
 * Runs on the HAST tree (after remark-rehype).
 */
function rehypeDemoteHeadings() {
  return (tree: import('hast').Root) => {
    visitHast(tree);
    function visitHast(node: import('hast').Nodes) {
      if (node.type === 'element') {
        const match = /^h([1-6])$/.exec(node.tagName);
        if (match) {
          const level = parseInt(match[1] as string, 10);
          const demoted = Math.min(level + 2, 6);
          node.tagName = `h${demoted}`;
        }
        for (const child of node.children) {
          visitHast(child);
        }
      } else if (node.type === 'root') {
        for (const child of node.children) {
          visitHast(child);
        }
      }
    }
  };
}

/**
 * Add `loading="lazy"` and `referrerpolicy="no-referrer"` to all `<img>` elements.
 * Runs before sanitization so the attributes survive the allowlist.
 */
function rehypeImageAttrs() {
  return (tree: import('hast').Root) => {
    addImageAttrs(tree);
    function addImageAttrs(node: import('hast').Nodes) {
      if (node.type === 'element') {
        if (node.tagName === 'img') {
          node.properties = {
            ...node.properties,
            loading: 'lazy',
            referrerPolicy: 'no-referrer',
          };
        }
        for (const child of node.children) {
          addImageAttrs(child);
        }
      } else if (node.type === 'root') {
        for (const child of node.children) {
          addImageAttrs(child);
        }
      }
    }
  };
}

export interface RenderMarkdownOptions {
  /**
   * Site host for foreign-link detection. Anchors whose host !== siteHost
   * receive `target="_blank" rel="noopener nofollow"`. Hostless (relative)
   * anchors are always internal. Omit to treat every anchor as internal
   * (no rewriting).
   */
  readonly siteHost?: string;
  /**
   * Returns true if `username` (a Person slug) resolves to a known Person.
   * Matched `@<slug>` text in markdown source becomes `<a href="/members/<slug>">@<slug></a>`.
   * Omit to leave all mentions as literal text.
   */
  readonly resolveMention?: (username: string) => boolean;
}

export interface RenderMarkdownResult {
  readonly html: string;
  readonly excerpt: string;
}

/**
 * Render markdown source to sanitized HTML and a plaintext excerpt.
 *
 * The excerpt uses the first paragraph's text, stripped of all markdown
 * formatting, capped at 280 chars with word-boundary truncation.
 *
 * `opts.resolveMention` + `opts.siteHost` enable the two custom transforms
 * declared in specs/behaviors/markdown-rendering.md. With both omitted, the
 * output matches the pipeline's pre-transform behavior.
 */
export function renderMarkdown(
  source: string,
  opts: RenderMarkdownOptions = {},
): RenderMarkdownResult {
  const html = renderHtml(source, opts);
  const excerpt = renderExcerpt(source, 280);
  return { html, excerpt };
}

function renderHtml(source: string, opts: RenderMarkdownOptions): string {
  // The two custom transforms are split across the remark (Mdast) and rehype
  // (HAST) sides of the pipeline. Both are conditional on opts, so the chain
  // is built in two stages with a typed-cast bridge — unified's per-`.use()`
  // type narrowing makes it awkward to assign-then-extend a pipeline value
  // when the set of plugins varies at runtime.
  //
  // The `eslint-disable` is for `@typescript-eslint/no-explicit-any` on the
  // bridge cast; unified's type machinery doesn't model the conditional shape.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let processor: any = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks);
  if (opts.resolveMention) {
    processor = processor.use(remarkMentions, { resolveMention: opts.resolveMention });
  }
  processor = processor
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeDemoteHeadings)
    .use(rehypeImageAttrs)
    .use(rehypeSanitize, sanitizeSchema);
  if (opts.siteHost) {
    processor = processor.use(rehypeExternalLinks, { siteHost: opts.siteHost });
  }
  return String(processor.use(rehypeStringify).processSync(source));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function renderExcerpt(source: string, maxLength: number): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(stripMarkdown)
    .use(remarkStringify)
    .processSync(source);

  const plain = String(file).trim();
  if (plain.length <= maxLength) return plain;

  // Try to break at a word boundary within the limit
  const truncated = plain.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const breakAt = lastSpace > maxLength * 0.8 ? lastSpace : maxLength;
  return plain.slice(0, breakAt) + '…';
}
