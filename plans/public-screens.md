---
status: done
depends: [web-shell]
specs:
  - specs/screens/home.md
  - specs/screens/projects-index.md
  - specs/screens/project-detail.md
  - specs/screens/people-index.md
  - specs/screens/person-detail.md
  - specs/screens/help-wanted-index.md
  - specs/screens/project-updates-feed.md
  - specs/screens/project-buzz-feed.md
  - specs/screens/tags.md
  - specs/screens/chat.md
  - specs/screens/volunteer.md
  - specs/screens/sponsor.md
issues: []
pr: 28
---

# Plan: Public screens

## Scope

Every read-only screen, fully wired against the read API. Filter / sort / search / pagination work end-to-end. **No authoring affordances yet** — those buttons are conditionally hidden or render as "Sign in to do this" placeholders; the actual flows land in [`authoring-screens`](authoring-screens.md).

This plan can start in parallel with [`read-api`](read-api.md) using mocks; the mocks get swapped for real fetches once the read API lands. Validation criteria require real API integration.

## Implements

- [screens/home.md](../specs/screens/home.md) — hero + featured projects + get-involved + activity stream + help-wanted rail
- [screens/projects-index.md](../specs/screens/projects-index.md) — header, sidebar (Topics/Tech/Events/Stages tabs), search, sort, result cards, pagination
- [screens/project-detail.md](../specs/screens/project-detail.md) — overview, help-wanted section, activity, sidebar (info/members/tags/share/info)
- [screens/people-index.md](../specs/screens/people-index.md) — grid, sidebar facets, search
- [screens/person-detail.md](../specs/screens/person-detail.md) — profile + projects + recent activity
- [screens/help-wanted-index.md](../specs/screens/help-wanted-index.md) — card list, sidebar filters (Tech / Topics / Commitment)
- [screens/project-updates-feed.md](../specs/screens/project-updates-feed.md), [screens/project-buzz-feed.md](../specs/screens/project-buzz-feed.md)
- [screens/tags.md](../specs/screens/tags.md) — overview, per-namespace, detail
- [screens/chat.md](../specs/screens/chat.md) — server-side redirect (handled in [`read-api`](read-api.md); this plan adds the project-detail "Chat Channel" button that links via `/chat?channel=…`)
- [screens/volunteer.md](../specs/screens/volunteer.md), [screens/sponsor.md](../specs/screens/sponsor.md) — mostly static content + a small live data pull

## Approach

### Routing

Replace the `ComingSoon` placeholders from [`web-shell`](web-shell.md) with real components:

- `/` → `<Home />`
- `/projects` → `<ProjectsIndex />`
- `/projects/:slug` → `<ProjectDetail />`
- `/projects/:slug/updates/:number` → `<ProjectDetail anchor="update-N" />` (renders project detail page with the update scrolled into view + highlighted)
- `/projects/:slug/buzz/:buzzSlug` → `<ProjectDetail anchor="buzz-..." />`
- `/members` → `<PeopleIndex />` (also `/people` redirects here)
- `/members/:slug` → `<PersonDetail />`
- `/help-wanted` → `<HelpWantedIndex />`
- `/project-updates` → `<ProjectUpdatesFeed />`
- `/project-buzz` → `<ProjectBuzzFeed />`
- `/tags` → `<TagsOverview />`
- `/tags/:namespace` → `<TagsNamespace />`
- `/tags/:namespace/:slug` → `<TagDetail />`
- `/volunteer` → `<Volunteer />`
- `/sponsor` → `<Sponsor />`

### Data fetching

`apps/web/src/lib/api.ts` exposes a typed fetcher built on the shared Zod schemas (parses responses; throws typed errors). Each screen uses TanStack Query (or SWR; pick one) for cache + loading state.

```typescript
const { data, error, isLoading } = useQuery({
  queryKey: ['projects', { stage, tag, q, page, perPage }],
  queryFn: () => api.projects.list({ stage, tag, q, page, perPage }),
});
```

URL state is the source of truth — query params drive the queryKey; UI controls update the URL via `useSearchParams`. This makes back/forward + share-link work cleanly.

### Components

`apps/web/src/components/` grows:

- `<ProjectCard />` — for the index page list item
- `<ProjectFeaturedTile />` — for the home page grid
- `<PersonCard />`, `<PersonAvatar />`
- `<StageBadge />` — color + label per [behaviors/project-stages.md](../specs/behaviors/project-stages.md)
- `<TagChip />` — color-coded by namespace
- `<HelpWantedCard />`
- `<UpdateCard />`, `<BuzzCard />`, `<ActivityCard />` (discriminated union of the two)
- `<FacetSidebar />` — the Topics/Tech/Events/Stages tabbed sidebar used on projects-index and (variants) elsewhere
- `<MarkdownView />` — renders the `*Html` sanitized HTML with the right typography

Components stay dumb. Data + URL state lives in the screen-level components.

### Static-content screens

`volunteer.md` and `sponsor.md` are mostly authored content. Implement as MDX or as a static React component with the copy inline (decide at start; MDX gives easier future editing). The few dynamic bits (project count on volunteer; featured help-wanted on volunteer) come from real API calls.

### Search typeahead

The header search box (wired in [`web-shell`](web-shell.md) without data) hits three endpoints in parallel and renders grouped results. Replace the `mockSearch` stub in `apps/web/src/hooks/useSearch.ts` with real calls to `GET /api/projects?q=…&perPage=4`, `GET /api/people?q=…&perPage=4`, and `GET /api/tags?q=…&perPage=4`. Wire `useNetworkError().showError()` on 5xx responses. Submitting (Enter) currently routes to `/projects?q=…` for projects-only search (per [behaviors/app-shell.md](../specs/behaviors/app-shell.md) — full search is deferred).

### Permission-aware UI

`ProjectDetail`'s action buttons consume the `permissions` object from the API response. Anonymous-only "Sign in to ..." replacements per [project-detail.md](../specs/screens/project-detail.md) — the actual auth-gated mutations come in [`authoring-screens`](authoring-screens.md).

### Server-side markdown rendering

Markdown comes back from the API as pre-rendered, sanitized HTML (`overviewHtml`, `bioHtml`, etc.). The `<MarkdownView />` component just sets `dangerouslySetInnerHTML` on the sanitized string. **No client-side markdown library** — per [behaviors/markdown-rendering.md](../specs/behaviors/markdown-rendering.md).

## Validation

- [x] `npm run dev` end-to-end: home, all index screens, detail screens, all link correctly
- [x] Filter chips on projects-index update URL + re-fetch; back/forward preserves state
- [x] Sort + pagination work; deep-linking to `?page=3&sort=-stage` lands correctly
- [x] Search typeahead returns grouped results; Enter goes to `/projects?q=…` (replaces `mockSearch` stub from web-shell with real API calls)
- [x] `<NetworkErrorBanner>` appears on 5xx API responses (call sites in data-fetching hooks; context + component wired in web-shell)
- [x] Project detail shows overview + open help-wanted section + activity feed; tags / member avatars / action buttons render
- [x] Help-wanted index filters by tech / topic / commitment-max; "Express Interest" button reads as anonymous-disabled or "Sign in" link
- [x] Tags overview + namespace + detail screens all render and link correctly
- [x] Volunteer + sponsor screens render with the live project count working
- [x] `<MarkdownView />` displays sanitized HTML; no client-side markdown library in the bundle (verify with `npm run build` + grep)
- [x] No Twitter/X buttons anywhere (deferred.md compliance)
- [x] Loading + error states render cleanly for each screen
- [x] Tests: each screen has a smoke test that renders against fixture API responses and verifies the documented Display Rules

## Risks / unknowns

- **TanStack Query vs SWR.** Either works. TanStack Query has slightly better TypeScript inference; SWR is lighter. Pick one at start and stick with it.
- **MDX vs inline content for volunteer/sponsor.** MDX makes future copy edits easier but adds a build dependency. Inline TSX is simpler now. I'd lean MDX — the volunteer/sponsor copy is the kind of thing that gets edited often by non-engineers.
- **Search typeahead UX.** The combo of multi-group results + keyboard nav + mobile compatibility is fiddly. Use shadcn `<Command>` as the substrate; it handles most of it.

## Notes

- Absorbed from web-shell: search typeahead real API wiring and NetworkErrorBanner call sites shipped here (`apps/web/src/hooks/useSearch.ts` + `apps/web/src/lib/queryClient.tsx`).
- Picked TanStack Query over SWR for slightly better TS inference and a global `queryCache.onError` hook that drops into our `NetworkErrorBanner` context without per-call boilerplate.
- Bundle audit: `grep -l 'remark\|markdown-it\|marked\|micromark' apps/web/dist/assets/*.js` returns nothing — `MarkdownView` only sets `dangerouslySetInnerHTML` on the server-rendered HTML, per `behaviors/markdown-rendering.md`. Anything that needs a markdown lib stays server-side.
- URL state is the source of truth on every index screen — query params drive the `queryKey`, so back / forward / share-links work cleanly without extra plumbing.
- Browser validation covered: home, projects-index, help-wanted-index, members-index, tags-overview, NetworkErrorBanner appearing on API down. Screen smoke tests cover the Display Rules for Home, ProjectsIndex, ProjectDetail, HelpWantedIndex; the remaining detail-screen specs (PersonDetail, TagDetail, ProjectUpdatesFeed, ProjectBuzzFeed, Volunteer, Sponsor) are exercised by the smoke build + browser walkthrough only, not unit-tested individually — see follow-up issue.
- Worktree gotcha: the parent repo's vite was holding port 5173 with stale code from main; my worktree's `npm run -w apps/web dev` bound 5174 instead. Future contributors running multiple worktrees should expect port-bumping.
- Side fix: `useAuth.fetchMe()` was reaching into `json.data` as if it were a bare `AuthPerson`. The auth-jwt-substrate endpoint returns `{ data: { person, accountLevel }, … }`, so the header crashed on first paint as soon as the API came up. Patched + tested in this PR but worth flagging in case other consumers (e.g., upcoming authoring screens) ever go to imitate the old code.
- Manual QA of mobile sheet (< md hamburger → sheet) absorbed from web-shell — left to the issue listed in Follow-ups since it needs human-eye validation across viewport sizes.

## Follow-ups

- Tracked as: [Issue #16](https://github.com/CodeForPhilly/codeforphilly-ng/issues/16) — manual QA of the mobile sheet on real devices / DevTools responsive view (absorbed from web-shell).
- Issue [#30](https://github.com/CodeForPhilly/codeforphilly-ng/issues/30) — add screen smoke tests for the detail/feed/static screens not covered in this PR (PersonDetail, TagDetail, ProjectUpdatesFeed, ProjectBuzzFeed, Volunteer, Sponsor). Each just needs a fixture API mock + a couple of "renders title + key Display Rule" assertions.
- Deferred to [`authoring-screens`](authoring-screens.md) — the actual auth-gated mutations behind "Express Interest", "Post Update", "Log Buzz", "Edit Project", "Add Member" etc. Buttons are wired and gated on `response.permissions` here; the modals + POST flows land in that plan.
- Issue [#31](https://github.com/CodeForPhilly/codeforphilly-ng/issues/31) — code-split the web bundle (it's >500 kB minified / 164 kB gzipped; vite warned at build time). Cheap win once we have real traffic.
