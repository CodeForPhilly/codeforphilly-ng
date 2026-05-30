---
status: in-progress
depends: [screen-gaps-phase2]
specs:
  - specs/behaviors/app-shell.md
issues: [83]
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

- [ ] `npm install marked` lands as its own commit.
- [ ] `apps/web/src/content/pages/` has 4 markdown files.
- [ ] `/pages/mission`, `/pages/leadership`, `/pages/code-of-conduct`, `/pages/hackathons` all render their content.
- [ ] `/pages/nonexistent` renders the NotFound screen.
- [ ] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **`import.meta.glob` is Vite-specific.** Confirmed by the existing codebase using Vite — same mechanism would need a polyfill or alternative if we ever switched bundlers. Out of scope to worry about.
- **Bundle size.** `marked` adds ~30 KB. Acceptable for static-content rendering. If bundle pressure becomes a concern later, swap to a Vite plugin that pre-renders to HTML at build time and import the HTML directly.
- **Placeholder content** is honest about being placeholder, but a casual visitor will still see "this hasn't been ported yet" on real pages. Trade-off: ship the plumbing now so the spec is satisfied; content PR follows.

## Notes

*(filled at done time)*

## Follow-ups

*(filled at done time)*
