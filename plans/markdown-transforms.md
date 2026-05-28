---
status: done
depends: []
specs:
  - specs/behaviors/markdown-rendering.md
issues: [81]
pr: 91
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

- [x] `packages/shared/tests/markdown.test.ts` covers all the external-link + mention cases listed above (16 new tests; 69/69 pass).
- [x] `renderMarkdown(source)` (no opts) preserves existing behavior — the no-opts call in `common.ts`'s default `currentRender` keeps every pre-existing test passing without changes.
- [x] `apps/api` serializers route through `common.renderMarkdown` (which dispatches to the boot-installed renderer); every direct `@cfp/shared` import was replaced.
- [x] API-level smoke tests: `tests/preview.test.ts` exercises the external-link rewrite + `@mention` resolution end-to-end through the boot-installed renderer (7 cases pass, including a seeded `@chris` → `<a href="/members/chris">@chris</a>`).
- [x] `CFP_SITE_HOST` added to `env.ts` + JSON schema (default `codeforphilly.org`). Configmap/`.env.example`/deploy.md env-table entries follow in this PR.
- [x] `npm run type-check && npm run lint && npm run -w apps/api test` clean (244/244 API tests; 69/69 shared tests).

## Risks / unknowns

- **Slug boundary edge cases** — `@chris.` should link "@chris" but not "@chris.". The regex needs `[a-z0-9-]+` with a lookahead/non-capture for the boundary. Tests cover.
- **Mentions inside HTML-ish content** — sanitizer strips raw HTML before our HAST plugin runs, so we don't need to worry about `<span>@chris</span>` cases.
- **Protocol-relative URLs** (`//other.example/path`) — `new URL()` requires a base; we'll need a sentinel base when parsing the anchor href to handle these correctly.
- **siteHost mismatch in sandbox vs prod** — `next-v2.codeforphilly.org` (sandbox) vs `codeforphilly.org` (prod). At cutover, the env value flips. Until then, links to `codeforphilly.org` from sandbox content will (correctly) be treated as foreign. Documented behavior, not a bug.
- **Mention resolution cost** — the resolver is a `Map.has()` call; per-mention cost is O(1). With many mentions per document we might call the resolver many times but it's still cheap. No memoization needed.

## Notes

Shipped across the plan opening commit plus three implementation commits (shared transforms + tests, API wiring + env, docs/configmap). 16 new unit tests in `@cfp/shared` cover both transforms; 2 new integration tests in `preview.test.ts` confirm the end-to-end wiring.

Surprises:

- **Serializer wiring shape.** Originally I planned a Fastify decorator (`fastify.renderMarkdown(source)`), but the serializers are pure functions with no Fastify reference — threading the decorator through would have meant changing every serializer signature + every call site. Instead, the plugin installs a renderer into a module-level binding in `apps/api/src/services/serializers/common.ts` via `setRenderMarkdown(fn)`. Serializers import a stable `renderMarkdown` from `common.ts` that dispatches to whichever function the plugin most recently installed; tests + ad-hoc scripts fall back to the bare `@cfp/shared` renderer with no setup. Single-process Fastify app means a per-process binding is the right shape — no concurrency hazard, no test isolation issue (every `buildApp()` re-runs the plugin and re-binds).
- **Mention slug-boundary subtlety.** The word-start check (`@chris` must not match inside `alice@chris.example`) needed a manual char-class check on the character preceding `@` because JS regex lookbehind syntax (`(?<![a-z0-9])`) is supported on modern engines but I kept the implementation portable. The cost is one branch per match — trivial.
- **`URL` constructor in `@cfp/shared`.** First pass used `new URL(href, base)` for host parsing in the external-link transform. The shared package's tsconfig doesn't include DOM or `@types/node`, so the compiler couldn't find `URL`. Rather than add a node types dep to shared (which serves web too), I switched to a tiny regex-based `hostOf(href)` helper. The subset we actually need from URL parsing is narrow — "does this href have a host, and if so, what is it" — and the regex is clearer than dragging in type defs.
- **`renderField` was already dead code.** The pre-existing `renderField(source)` helper in `common.ts` was exported but never used — discovered while routing the new renderer through `common.ts`. Deleted as part of this work.

## Follow-ups

- **Mention resolution caching** — the resolver is a `Map.has()` call, already O(1). If profiling ever shows hot rendering paths (long blog posts with many mentions), we could memoize per-render-call. *Tracked as:* low priority; bring up if it appears in flamegraphs.
- **Image proxying** — `behaviors/markdown-rendering.md` notes a planned `/img-proxy?u=...` transform not yet implemented. Separate issue; this PR is just the two transforms the spec calls out as v1.
- **Configurable mention paths** — `/members/<slug>` is hardcoded in the Mdast plugin. If we ever surface `@<slug>` in non-Person contexts (e.g. a future `@<projectSlug>` for projects), the link template would need to come from options. *Deferred* until that use case lands.
