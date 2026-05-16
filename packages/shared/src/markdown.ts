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

export interface RenderMarkdownResult {
  readonly html: string;
  readonly excerpt: string;
}

/**
 * Render markdown source to sanitized HTML and a plaintext excerpt.
 *
 * The excerpt uses the first paragraph's text, stripped of all markdown
 * formatting, capped at 280 chars with word-boundary truncation.
 */
export function renderMarkdown(source: string): RenderMarkdownResult {
  const html = renderHtml(source);
  const excerpt = renderExcerpt(source, 280);
  return { html, excerpt };
}

function renderHtml(source: string): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeDemoteHeadings)
    .use(rehypeImageAttrs)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeStringify)
    .processSync(source);

  return String(file);
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
