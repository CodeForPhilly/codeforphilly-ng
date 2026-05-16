# Behavior: Markdown Rendering

## Rule

User-authored prose fields (`Project.readme`, `Person.bio`, `ProjectUpdate.body`, `ProjectBuzz.summary`, `HelpWantedRole.description`) are stored as markdown source and delivered to the client as **pre-rendered, sanitized HTML** alongside the source. Rendering happens server-side; clients never invoke a markdown library on user-provided content.

## Applies To

- All API responses with a `*Html` field paired with a markdown source field
- Markdown editor widget on every authoring screen
- Plaintext excerpt generation (used for list previews and meta descriptions)

## Pipeline

```text
markdown source
     │
     ▼
remark-parse  →  remark-gfm  →  remark-breaks
     │
     ▼
remark-rehype (allowDangerousHtml: false)
     │
     ▼
rehype-sanitize  (schema: see below)
     │
     ▼
rehype-stringify  →  rendered HTML
```

The same pipeline runs:

- On write — to validate that the source produces non-empty output if the field is required, and to surface any sanitizer warnings.
- On read — to populate the `*Html` field in API responses. The result is **not** cached in the database column; it's computed on serialization. (If profiling shows this is a hot spot, cache `*Html` alongside `*Source` and invalidate on write. Don't pre-optimize.)

## What's allowed

GFM features:

- Headings (h1–h6) — but the renderer demotes by 2 (h1 in source → h3 in output) so a project README's `# Foo` doesn't clash with the page's own H1
- Paragraphs, line breaks, soft breaks
- Strong, emphasis, strikethrough
- Inline code, fenced code blocks (no syntax highlighting in v1 — class is preserved for future client-side highlighting if desired)
- Ordered and unordered lists, nested
- Task lists (rendered with disabled checkboxes; not interactive in v1)
- Tables
- Links — only `http`, `https`, `mailto` schemes
- Images — only `https` scheme, with `loading="lazy"` and `referrerpolicy="no-referrer"` added
- Blockquotes
- Horizontal rules
- Autolinks (URLs that aren't markdown-linked become anchors)

## What's stripped

- Raw HTML in source — entirely removed by `rehype-sanitize` (no `<script>`, no `<style>`, no `<iframe>`, no `<object>`)
- Any `on*` attributes
- `style` attributes
- `javascript:`, `data:`, `file:`, `vbscript:` URLs
- Unknown elements or attributes

## Custom transforms applied after sanitization

| Transform | Rule |
| --------- | ---- |
| Heading demotion | h1 → h3, h2 → h4, etc. Min level h6. |
| External link target | All `<a href>` whose host differs from the site host get `target="_blank" rel="noopener nofollow"` |
| Image proxying | (v1: not implemented; planned: route through `/img-proxy?u=...` to dodge mixed-content and DDoS-the-source issues) |
| `@mention` resolution | `@username` in update bodies — if `username` matches an existing person's slug, link to `/members/<slug>`. Otherwise leave the literal text. |

## Plaintext extraction

For list previews and meta descriptions, we need plain text — not rendered HTML. A separate pipeline runs:

```text
remark-parse → strip-markdown → trim whitespace → truncate
```

Truncation tries to break at a word boundary, then a sentence boundary if one is within 20% of the target length. Suffix `…` (single character) only if truncated.

Used for:

- `ProjectListItem.readmeExcerpt` (600 chars)
- `PersonListItem.bioExcerpt` (200 chars)
- HTML `<meta name="description">` (≤ 160 chars) for project detail and person detail pages
- OpenGraph `og:description` (same)

## Editor

Every markdown-authoring widget on the site uses the same component:

- Two-pane: source on the left, rendered preview on the right (using the same server pipeline, called on debounce)
- Toolbar with bold, italic, link, list, code, blockquote
- Drag-drop image upload is **not in v1** — paste an external `https://` URL
- Character count visible
- Soft hint when source exceeds the field's max length, hard reject on submit

The shadcn-compatible component choice is an implementation detail; the spec is the *behavior*, not the library.
