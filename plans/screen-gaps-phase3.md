---
status: done
depends: [screen-gaps-phase2]
specs:
  - specs/behaviors/app-shell.md
issues: [83]
pr: 104
---

# Plan: screen-gaps phase 3 — static `/pages/:slug` content

## Scope

[#83](https://github.com/CodeForPhilly/codeforphilly-ng/issues/83) phase 3 — closes the `<ComingSoon />` placeholders on `/pages/mission`, `/pages/leadership`, `/pages/code-of-conduct`, `/pages/hackathons` per [behaviors/app-shell.md](../specs/behaviors/app-shell.md):

> "The `/pages/*` URLs serve **static content pages** authored as MDX/Markdown in the code repo (`apps/web/src/content/pages/`). They have no per-page screen spec — the content is the spec."

This plan ships the *plumbing* (content directory, markdown→HTML build-time renderer, the `/pages/:slug` route). The actual copy is **placeholder** that calls itself out — porting the legacy laddr-site text is a content task, not an engineering one. Filed as a follow-up.

## Implements

- [behaviors/app-shell.md](../specs/behaviors/app-shell.md) — `/pages/*` URL pattern + content authoring location.

## Approach

### 1. Dependency

Add `marked` to `apps/web` for client-side markdown rendering. Choice rationale:

- Static pages are **not user content** — the CLAUDE.md "no client markdown" rule explicitly applies to user-supplied content (bios, project overviews, blog bodies). Build-time-static content is essentially JSX.
- `marked` is tiny (~30 KB min+gz) and battle-tested.
- The alternative — using `@cfp/shared`'s `renderMarkdown` server-side via a build-time Vite plugin — adds more tooling than the v1 needs.

No DOMPurify dance: zero XSS surface on content that lives in the bundle.

### 2. Content files

`apps/web/src/content/pages/`:

- `mission.md`
- `leadership.md`
- `code-of-conduct.md`
- `hackathons.md`

Each carries a placeholder body that names itself ("This page's content hasn't been ported from the legacy site yet — see [issue ref] to help.") plus an H1 + a paragraph. Real copy ports from codeforphilly.org as a content PR.

### 3. Renderer + route

`apps/web/src/pages/StaticPage.tsx`:

- `import.meta.glob('@/content/pages/*.md', { query: '?raw', import: 'default', eager: true })` builds a slug → markdown source map at build time.
- The component reads `:slug` from the route, looks up the matching source, parses with `marked`, and renders inside a `prose` typographic container.
- Unknown slug → `<NotFound />`.

`apps/web/src/App.tsx`:

- Replace `{ path: '/pages/:slug', element: <ComingSoon /> }` with `<StaticPage />`.

### 4. Styling

Reuse the existing typographic styles from `MarkdownView.tsx` (a `prose` container with tailwind targeting for headings, lists, code, blockquotes). DRY by extracting to a shared `MarkdownContent` wrapper, or just copy the class list — copy is cheaper for v1.

### 5. Tests

`apps/web/tests/StaticPage.test.tsx`:

- Renders the H1 from `mission.md`.
- Renders an unknown slug as NotFound.
- Renders all four bundled pages (smoke).

## Validation

- [x] `npm install marked` lands as its own commit.
- [x] `apps/web/src/content/pages/` has 4 markdown files.
- [x] `/pages/mission`, `/pages/leadership`, `/pages/code-of-conduct`, `/pages/hackathons` all render their content.
- [x] `/pages/nonexistent` renders the NotFound screen.
- [x] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **`import.meta.glob` is Vite-specific.** Confirmed by the existing codebase using Vite — same mechanism would need a polyfill or alternative if we ever switched bundlers. Out of scope to worry about.
- **Bundle size.** `marked` adds ~30 KB. Acceptable for static-content rendering. If bundle pressure becomes a concern later, swap to a Vite plugin that pre-renders to HTML at build time and import the HTML directly.
- **Placeholder content** is honest about being placeholder, but a casual visitor will still see "this hasn't been ported yet" on real pages. Trade-off: ship the plumbing now so the spec is satisfied; content PR follows.

## Notes

Three commits: plan-open, `npm install marked` (with the exact
command in the body, per the generated-files-commit-first convention),
content + StaticPage + tests.

Surprises:

- **`marked.parse` is sync-by-default in v18.** Earlier versions
  returned `string | Promise<string>` depending on extension config;
  v18+ defaults to sync unless a custom async extension is registered.
  The `{ async: false }` arg is belt-and-suspenders.
- **The `prose` class duplication.** `MarkdownView.tsx` and
  `StaticPage.tsx` carry similar Tailwind `prose` configs. Considered
  extracting to a shared wrapper, but the consumers diverge subtly:
  `MarkdownView` is for compact embedded markdown (project overviews,
  update bodies) and uses `prose-sm`; `StaticPage` is for full-width
  documentation and uses `prose-sm sm:prose-base`. Plus heading scales
  differ. Three-similar-lines vs. premature abstraction — kept the
  copy.
- **No DOMPurify dance.** Static-page content is build-time-static
  source; no XSS surface. `dangerouslySetInnerHTML` is the right tool
  here even though the name reads scary.

## Follow-ups

- **Port real copy from the legacy site.** Each of the four pages
  carries placeholder text that names itself as such. The real text
  lives at `codeforphilly.org/site-root/pages/`. *Tracked as* —
  content-PR task; will file a tracking issue when content review
  has someone owning it.
- **Phase 4 — `/projects/:slug/buzz/new` form** stays the last open
  piece of [#83](https://github.com/CodeForPhilly/codeforphilly-ng/issues/83). *Deferred to plan* — `plans/buzz-new-form.md`.
- **MDX upgrade.** If `/pages/leadership` ever needs to render
  embedded React components (e.g., a live leadership-roster card),
  swap to `@mdx-js/rollup`. *None* for v1 — pure markdown is
  sufficient.
