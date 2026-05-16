---
status: in-progress
depends: [storage-foundation]
specs:
  - specs/behaviors/app-shell.md
  - specs/screens/login.md
issues: []
---

# Plan: Web shell

## Scope

The Vite + React app's chrome: app shell (header, footer, breadcrumbs, search box, mobile sheet), routing scaffold, auth bootstrap, shadcn/ui setup, placeholder routes for `/login` and `/account`. **No business screens** beyond a stub home page — those land in [`public-screens`](public-screens.md).

Out of scope: any real data display (mocks until [`read-api`](read-api.md) lands), any write actions, the actual GitHub OAuth button wiring (the `/login` button hits a placeholder endpoint until [`github-oauth`](github-oauth.md)).

## Implements

- [behaviors/app-shell.md](../specs/behaviors/app-shell.md) — header, primary nav, About dropdown, search box (typeahead UI; the API call gets wired in `public-screens`), auth controls (Anonymous variant only at this stage), footer, breadcrumbs, loading/error banners, accessibility skip-link, mobile sheet, print stylesheet
- [screens/login.md](../specs/screens/login.md) — the GitHub-OAuth-button screen as a placeholder (button currently hits the stub endpoint that returns 501)

## Approach

### Setup

1. From inside `apps/web/`, run the shadcn init: `npx shadcn@latest init -y` (per the `frontend-shadcn` skill). Commit the generated changes first per CLAUDE.md.
2. Add the components we'll use across the app: `button`, `card`, `dropdown-menu`, `sheet`, `dialog`, `input`, `tooltip`, `separator`, `tabs`. `npx shadcn@latest add ...`. Commit.
3. Install `react-router` (not `react-router-dom`). Wire `<BrowserRouter>` in `main.tsx`.
4. Tailwind v4 should be configured by shadcn init.

### Layout

`apps/web/src/components/AppShell.tsx` is the wrapper around every route. Renders header, optional breadcrumbs row, `<main>` slot, footer. Sticky header on scroll. Mobile sheet at `< md`.

`apps/web/src/components/AppHeader.tsx`:

- Logo + "Code for Philly"
- Primary nav: Projects, Help Wanted, Members, Volunteer (button), About (dropdown), Search
- Auth controls: "Sign in" button (anonymous) — replaced by avatar dropdown when signed in (post-`github-oauth`)
- Mobile: hamburger → `<Sheet>` with stacked nav

`apps/web/src/components/AppFooter.tsx`:

- Three columns (Explore, About, Connect) per the spec
- Social icons: Instagram, LinkedIn, Facebook, Meetup, Mastodon, Bluesky (per [deferred.md](../specs/deferred.md), no Twitter/X)
- Copyright + open-source-on-GitHub link

`apps/web/src/components/Breadcrumbs.tsx`:

- Each route declares its trail via a `breadcrumbs` export
- The trail builder reads route metadata; screens without `breadcrumbs` render nothing

### Routing

`apps/web/src/App.tsx`:

```typescript
<Routes>
  <Route element={<AppShell />}>
    <Route path="/" element={<HomeStub />} />
    <Route path="/projects" element={<ComingSoon />} />
    <Route path="/projects/:slug" element={<ComingSoon />} />
    <Route path="/help-wanted" element={<ComingSoon />} />
    <Route path="/members" element={<ComingSoon />} />
    <Route path="/members/:slug" element={<ComingSoon />} />
    <Route path="/volunteer" element={<ComingSoon />} />
    <Route path="/sponsor" element={<ComingSoon />} />
    <Route path="/account" element={<ComingSoonRequiresAuth />} />
    <Route path="/login" element={<LoginPlaceholder />} />
    <Route path="*" element={<NotFound />} />
  </Route>
</Routes>
```

`ComingSoon` is a placeholder that says "Coming soon — see [related plan link]" plus a back link.

`HomeStub` renders a small hero with "Code for Philly is being rebuilt" — replaced fully in `public-screens`.

### Auth bootstrap

`apps/web/src/hooks/useAuth.tsx` calls `GET /api/auth/me` on mount + provides `{person, accountLevel, signOut, reload}` via context. Header consumes it for the auth controls.

### Search box (UI only)

The header search input is wired with a debounced state hook, but the actual `GET /api/search` (or per-entity calls) it'll trigger is left as a TODO that returns mock results. The dropdown UX, keyboard navigation, and "See all results for X" link layout all work; the data is wired in `public-screens`.

### Dev proxy

`apps/web/vite.config.ts` proxies `/api/*` to `http://localhost:3001`. The API is started concurrently via the root `npm run dev`.

### Loading + error banners

A `<TopProgressBar>` component animates during navigation. A `<NetworkErrorBanner>` shows when an API call returns 5xx. An `<OfflineBanner>` shows when `navigator.onLine === false`.

### Accessibility

- Skip link as the first focusable element
- `<main>` has `id="main-content"` matching the skip link
- All dropdowns / sheets keyboard-navigable
- Mobile sheet traps focus while open

## Validation

- [ ] `npm run dev` boots both apps; the web app at `http://localhost:5173/` renders the shell with placeholders
- [ ] Header nav links all route correctly (to placeholders)
- [ ] About dropdown opens, keyboard-navigable
- [ ] Mobile (< md) shows hamburger → sheet with stacked nav
- [ ] `useAuth` calls `/api/auth/me` on mount; with no session, anonymous controls render
- [ ] Skip link works (Tab from page load → "Skip to main content" → Enter focuses `<main>`)
- [ ] `<NetworkErrorBanner>` appears when the api is down (kill it and reload `/`)
- [ ] Search box accepts input but submits to a stub that's TODO'd
- [ ] Footer renders three columns + social icons + open-source link
- [ ] No Twitter/X icon in the footer (deferred.md compliance)
- [ ] `npm test` passes; jsdom-based tests cover the auth bootstrap + the mobile sheet open/close

## Risks / unknowns

- **shadcn init disturbs files.** Commit the generated changes first, then add manual edits. Use the `frontend-shadcn` skill's recipe verbatim.
- **React Router v7 vs v6 imports.** The skill says use `react-router` not `react-router-dom` for v7. Stay disciplined.
- **Tailwind v4 + shadcn compatibility.** Should be fine but watch for class-name drift; pin the shadcn version that matches Tailwind v4.

## Notes
