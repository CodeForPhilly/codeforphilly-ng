# Behavior: App Shell

## Rule

Every screen on the site is rendered inside the same chrome — a sticky header, an optional breadcrumb row, the page content area, and a footer. The shell carries navigation, search, and auth state. Individual screen specs declare their *content*; this spec declares the *frame*.

## Applies To

Every URL except `/login` (which intentionally renders a minimal shell). The GitHub OAuth callback handler and the account-claim screens (not yet specified) will also use the minimal shell.

## Composition

```
┌─────────────────────────────────────────────────────┐
│                    Header                           │  sticky
├─────────────────────────────────────────────────────┤
│                    Breadcrumbs (optional)           │  conditional
├─────────────────────────────────────────────────────┤
│                                                     │
│                    Page content                     │  per-screen spec
│                                                     │
├─────────────────────────────────────────────────────┤
│                    Footer                           │
└─────────────────────────────────────────────────────┘
```

## Header

Sticky at the top of the viewport. Background opaque, slight shadow on scroll.

### Left

- Logo (`/img/logo.png`) — 32px tall, links to `/`
- Site name "Code for Philly" — visible at ≥ md, hidden below to save space

### Center / right at ≥ md

Primary nav, items in this order:

| Item | Target | Style |
| ---- | ------ | ----- |
| Projects | `/projects` | text link |
| Help Wanted | `/help-wanted` | text link |
| Members | `/members` | text link |
| Volunteer | `/volunteer` | button (success, filled) — emphasized because it's the call to action |
| About ▾ | dropdown | text link with caret |
| Search 🔍 | inline expand | icon button |

### About dropdown

- Mission → `/pages/mission`
- Leadership → `/pages/leadership`
- Code of Conduct → `/pages/code-of-conduct`
- Hackathons → `/pages/hackathons`
- Sponsor → `/sponsor`
- Contact → `/contact` (not yet specified; rendered as `mailto:` for v1)

The `/pages/*` URLs serve **static content pages** authored as MDX/Markdown in the code repo (`apps/web/src/content/pages/`). They have no per-page screen spec — the content is the spec. Source copy ports from `codeforphilly.org/site-root/pages/` in the legacy repo.

### Auth controls (rightmost)

- **Anonymous:** "Sign in" (primary button) → `/login`. There is no separate "Sign up" button — sign-in and sign-up are the same flow once GitHub OAuth is specified (first sign-in creates the account).
- **User:** Avatar + name dropdown:
  - "My profile" → `/members/<slug>`
  - "Account settings" → `/account`
  - separator
  - "My projects" → `/projects?memberSlug=<slug>`
  - separator
  - "Sign out" → calls `POST /api/auth/logout`, redirects to `/`
- **Staff:** Same dropdown plus a "Staff tools" section:
  - "Manage tags" → `/tags?staff=true`
  - "Recent staff actions" → deferred placeholder
- **Administrator:** Staff items plus "Admin" section:
  - "Manage members" → `/members?staff=true&accountLevel=all`

### Mobile (< md)

Header collapses to: logo + hamburger menu + auth control. Hamburger opens a sheet (right-side overlay) with all nav items stacked vertically. Search is inside the sheet, not inline.

## Search

Single search input in the header. Behavior:

- Placeholder: "Search projects, members, tags…"
- On focus, expands to fit the available space
- As the user types (debounced 200ms), a dropdown shows up to 8 results across types — matches laddr's site-wide search but in a typeahead form instead of a full results page
- Result groups:
  - "Projects" — `GET /api/projects?q=...&perPage=4`
  - "Members" — `GET /api/people?q=...&perPage=4`
  - "Tags" — `GET /api/tags?q=...&perPage=4`
- "See all results for `<q>`" link at the bottom → `/search?q=<q>`
- `Enter` key submits to `/search?q=<q>`

The `/search` results page is **deferred**; for v1 we ship only the typeahead and the `/search` page renders a redirect-to-projects with the q prefilled. Tracked in [deferred.md](../deferred.md) as a follow-up.

Sort order within each group: relevance (SQLite FTS5 BM25 rank — see [behaviors/storage.md](storage.md#full-text-search)).

## Breadcrumbs

Optional row below the header. A screen opts in by declaring a `breadcrumbs` trail; screens without one render the page content immediately under the header.

| Screen | Breadcrumb trail |
| ------ | ---------------- |
| `/projects` | (none — top-level) |
| `/projects/:slug` | Projects › `<title>` |
| `/projects/:slug/edit` | Projects › `<title>` › Edit |
| `/projects/create` | Projects › New project |
| `/members` | (none) |
| `/members/:slug` | Members › `<fullName>` |
| `/tags/:namespace/:slug` | Tags › `<namespace>` › `<title>` |
| `/help-wanted` | (none) |
| `/account` | Settings |

Each segment except the last is a link to the parent route.

## Footer

Three columns at ≥ md, stacked below.

### Column 1: Explore

- Active Projects → `/projects`
- Start a Project → `/projects/create` (or external link for anonymous)
- Hackathons → `/pages/hackathons`
- Members → `/members`
- Help Wanted → `/help-wanted`

### Column 2: About

- Mission → `/pages/mission`
- Leadership → `/pages/leadership`
- Code of Conduct → `/pages/code-of-conduct`
- Sponsor → `/sponsor`
- Contact → `/contact`

### Column 3: Connect

- Slack → `/chat`
- Newsletter signup (defer)
- Social icons: Instagram, LinkedIn, Facebook, Meetup, Mastodon, Bluesky
  - Twitter/X is **not** in v1; see [deferred.md](../deferred.md)

### Bottom strip

- "Copyright © Code for Philly 2011 – {currentYear}" (year computed at render time)
- "Open source — view this site on GitHub" link to the rewrite repo
- "Powered by laddr" credit is **gone** (see [deferred.md](../deferred.md))

## Page-level state in shell

The shell reads:

- `GET /api/auth/me` on first load — once, then cached in a React context
- The current route — for active-link styling and breadcrumb construction

It does not block initial paint waiting on `me`. Auth controls render skeletons until the response arrives.

## Loading + errors

- Top-of-page progress bar (1–2px) animates during full-page navigations
- Top-of-page red banner when an API call returns 5xx ("Something went wrong. We're looking at it. [Retry]")
- A red banner when offline ("You're offline. Some features may not work.") — driven by `navigator.onLine`

## Accessibility

- Logo is a link with visible text inside it ("Code for Philly")
- Skip link at the very top: "Skip to main content" → focuses the `<main>` element
- All dropdowns are keyboard-navigable
- The mobile sheet traps focus while open and returns it to the trigger on close

## Print

A print stylesheet hides the header, footer, breadcrumbs, search dropdown, and any auth controls. Pages print as their content area.
