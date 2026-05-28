---
status: in-progress
depends: []
specs:
  - specs/behaviors/markdown-rendering.md
issues: [81]
---

# Plan: Markdown @mention + external-link transforms

## Scope

[`specs/behaviors/markdown-rendering.md`](../specs/behaviors/markdown-rendering.md) declares two custom transforms over the unified pipeline. Neither is implemented today:

1. **External-link transform** — anchors whose host differs from the site host get `target="_blank" rel="noopener nofollow"`. Internal links don't.
2. **`@mention` resolution** — `@<slug>` in body text resolves against the in-memory person directory; matched mentions become links to `/members/<slug>`, unmatched ones stay as literal text.

The existing pipeline ([`packages/shared/src/markdown.ts`](../packages/shared/src/markdown.ts)) already does parse → GFM → breaks → rehype → sanitize → stringify, with heading demotion and image attribute injection. This plan adds two more plugin steps + threads options through the public API + wires the API side to supply them.

Closes [#81](https://github.com/CodeForPhilly/codeforphilly-ng/issues/81).

## Implements

- [behaviors/markdown-rendering.md](../specs/behaviors/markdown-rendering.md) — the two "custom transforms applied after sanitization" rows.

## Approach

### 1. `@cfp/shared` — extend `renderMarkdown` signature

```ts
export interface RenderMarkdownOptions {
  /** Site host for foreign-link detection. Anchors whose host !== siteHost get target=_blank rel=noopener nofollow. Omit to treat all anchors as internal. */
  readonly siteHost?: string;
  /** Returns true if the username (a person slug) resolves to a known Person. Omit to leave mentions as literal text. */
  readonly resolveMention?: (username: string) => boolean;
}

export function renderMarkdown(source: string, opts?: RenderMarkdownOptions): RenderMarkdownResult;
```

Backward-compatible — no-args call retains today's behavior (excerpts work the same, no external-link rewriting, mentions stay literal). The two existing in-tree call sites that don't yet need the transforms keep working without changes.

### 2. `remarkMentions` plugin (Mdast)

Mdast-level walk over text nodes inside paragraphs / list items / table cells / blockquotes. Skips text inside `inlineCode` and `code` nodes (mdast tags those distinctly, so walking only text nodes already accomplishes this). The regex matches the `Person.slug` shape from `packages/shared/src/schemas/person.ts`: `/^[a-z0-9][a-z0-9-]{1,49}$/`. In a text node we look for `@<slug>` where the slug begins right after `@` and continues until a non-`[a-z0-9-]` character or end of text.

For each match: if `resolveMention(slug)` returns true, split the text node into [prefix-text, link, suffix-text]. The link node is `{ type: 'link', url: '/members/<slug>', children: [{ type: 'text', value: '@<slug>' }] }`. Otherwise leave the text alone.

Runs **before** remark-rehype so the resulting link flows through the existing sanitizer (the destination is a relative URL, which the sanitizer's `protocols.href` config already permits).

### 3. `rehypeExternalLinks` plugin (HAST)

HAST-level walk over `element` nodes with `tagName === 'a'`. Parses the `href` and compares its host to the configured `siteHost`. If the href has no host (relative URL) or host matches → internal, no change. If foreign → set `properties.target = '_blank'` and `properties.rel = 'noopener nofollow'`.

Adds `target` and `rel` to the sanitizer schema's `a` attribute allowlist (already there: `attributes.a` includes both per the existing schema lines 27-30, so no schema change needed).

Runs **after** sanitization so we operate on the trusted tree.

### 4. API wiring — Fastify decorator

New plugin `apps/api/src/plugins/markdown.ts`:

```ts
fastify.decorate('renderMarkdown', (source: string) =>
  renderMarkdown(source, {
    siteHost: env.CFP_SITE_HOST,
    resolveMention: (slug) => fastify.inMemoryState.bySlug.person.has(slug),
  }),
);
```

Registered after the store plugin so `inMemoryState` is decorated first. Serializers swap from `renderMarkdown(source)` to `fastify.renderMarkdown(source)` — six call sites:

- `apps/api/src/services/serializers/common.ts:59` (`renderField` helper — central choke point)
- `apps/api/src/services/serializers/project.ts:118,179`
- `apps/api/src/services/serializers/project-buzz.ts:33`
- `apps/api/src/services/serializers/person.ts:82,111`
- `apps/api/src/services/serializers/project-update.ts` (one call)
- `apps/api/src/services/serializers/help-wanted.ts:53`
- `apps/api/src/routes/preview.ts:44`

Most go through `renderField` already; the others get direct decorator access.

### 5. Env — `CFP_SITE_HOST`

Add to `apps/api/src/env.ts`. Required string. Documented sandbox value: `next-v2.codeforphilly.org`. Production will set to `codeforphilly.org` at cutover. Local dev: `localhost:5173` (the Vite dev port — though it doesn't matter much locally since user content rarely contains site-internal links during dev).

Update `.env.example`, `deploy/kustomize/base/configmap.yaml`, the env table in `docs/operations/deploy.md`.

### 6. Tests

`packages/shared/tests/markdown.test.ts` — coverage:

- **External-link**:
  - foreign-host anchor → `target=_blank rel="noopener nofollow"` added
  - internal anchor (same host) → unchanged
  - relative anchor (`/people/x`) → unchanged
  - protocol-relative `//other.example/p` → treated as foreign
  - `mailto:` → no change (no host to compare)
  - `siteHost` omitted → all anchors stay internal (no rewriting)
- **`@mention`**:
  - resolver returns true → `@chris` becomes `<a href="/members/chris">@chris</a>`
  - resolver returns false → literal `@chris`
  - resolver omitted → literal
  - inside inline code (`` `@chris` ``) → literal
  - inside fenced code → literal
  - resolver only invoked once per unique mention (small perf win)
  - emails (`alice@example.com`) — the `@chris` regex requires word-start (not after `[a-z0-9]`), so emails don't match
  - trailing punctuation (`@chris,` or `@chris.`) — slug captured up to non-slug char, link wraps just the `@chris`

API-side test: a serializer-level smoke test that confirms the decorator wires through siteHost + resolver (one integration test covering the happy path is enough; the unit tests cover the pipeline logic).

## Validation

- [ ] `packages/shared/tests/markdown.test.ts` covers all the external-link + mention cases listed above.
- [ ] `renderMarkdown(source)` (no opts) preserves existing behavior — confirmed by the unchanged existing tests.
- [ ] `apps/api` serializers route through `fastify.renderMarkdown`; `grep -r "renderMarkdown(" apps/api/src/ | grep -v "fastify.renderMarkdown"` returns empty (or only the import line).
- [ ] One API-level smoke test confirming the decorator delivers — e.g. `/api/projects/:slug` with a body containing `@chris` resolves to a link when `chris` is in the seeded data.
- [ ] `CFP_SITE_HOST` added to `env.ts`, `.env.example`, configmap, deploy.md env table.
- [ ] `npm run -w packages/shared build && npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Slug boundary edge cases** — `@chris.` should link "@chris" but not "@chris.". The regex needs `[a-z0-9-]+` with a lookahead/non-capture for the boundary. Tests cover.
- **Mentions inside HTML-ish content** — sanitizer strips raw HTML before our HAST plugin runs, so we don't need to worry about `<span>@chris</span>` cases.
- **Protocol-relative URLs** (`//other.example/path`) — `new URL()` requires a base; we'll need a sentinel base when parsing the anchor href to handle these correctly.
- **siteHost mismatch in sandbox vs prod** — `next-v2.codeforphilly.org` (sandbox) vs `codeforphilly.org` (prod). At cutover, the env value flips. Until then, links to `codeforphilly.org` from sandbox content will (correctly) be treated as foreign. Documented behavior, not a bug.
- **Mention resolution cost** — the resolver is a `Map.has()` call; per-mention cost is O(1). With many mentions per document we might call the resolver many times but it's still cheap. No memoization needed.

## Notes

_(filled at done time)_

## Follow-ups

_(filled at done time)_
