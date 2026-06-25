# Screen: Home

## Route

`/` — public.

Replaces both:

- `codeforphilly.org/` (the hand-curated marketing landing)
- The laddr `home.tpl` activity feed + meetups sidebar

This v1 page is a blend: marketing hero + featured projects + live activity. The hard-coded portfolio from `codeforphilly.org/html-templates/home.tpl` is replaced by a curated-from-data approach driven by a small `featured` flag.

## Data Requirements

- `GET /api/projects?featured=true&perPage=8` — featured project list (Project list items)
  - `featured` is a new boolean column on `projects` (add to [data-model.md](../data-model.md#project)). Staff toggles it.
- `GET /api/project-updates?perPage=10` — recent activity for the activity stream
- `GET /api/help-wanted?perPage=4&sort=-createdAt` — recent open roles for the "How to help" rail
- `GET /api/auth/me` — bootstraps the auth context (changes header CTA)

## Display Rules

The page is composed of four sections, top to bottom:

### 1. Hero

- Site logo, headline, subhead
  - Headline: "Contribute towards technology-related projects that benefit the City of Philadelphia."
  - Subhead: "No coding experience required."
- Primary CTA: "Volunteer" (links to `/volunteer`)
- Background: a Ken Burns photo slideshow rendered by `<HeroSlideshow />`. Photos live in `apps/web/public/hero/` as optimized JPG (primary) + WebP (via `<picture>`), with a `manifest.json` index. On mount the photo set is shuffled; each photo is displayed for 8 seconds with a slow ambient pan (scale 1.05 → 1.10, translate ±2% on a randomized vector), then crossfades to the next over 1.5 seconds while the incoming photo immediately starts its own independent random pan. The `prefers-reduced-motion` media query disables the pan entirely; the crossfade still occurs. A dark gradient overlay sits above the photos to keep hero text legible. Asset regeneration is reproducible via `apps/web/scripts/optimize-hero-photos.sh <input-dir>`.
- If the user is signed in, the primary CTA changes to "Browse Projects" (`/projects`).

### 2. Featured projects

- Heading: "Join a Project"
- Grid: responsive — 3 columns ≥ md, 2 columns ≥ sm, 1 column < sm
- Up to 8 featured tiles. Each tile shows:
  - Project image — `project.featuredImageKey` (required field when `project.featured = true`; see [data-model.md#project](../data-model.md#project))
  - Title
  - Tagline = `project.summary`, or first line of `overviewExcerpt` if `summary` is null
  - Click: links to `/projects/<slug>`
- Below the grid: "See all 268 projects →" link to `/projects`. The count is `metadata.totalItems` from a separate cheap `HEAD`-style call (or piggybacked from the featured response — implementer's call).

If no featured projects have a `featuredImageKey` set, the section renders no tiles (rendered empty rather than hidden — the heading stays so staff notice).

### 3. Get involved

Three side-by-side cards (current site has these; they translate cleanly):

| Card | Heading | Body | Link |
| ---- | ------- | ---- | ---- |
| Sponsor | "Sponsor" | "Sponsor an event" | `/sponsor` |
| Start a Project | "Start a Project" | "Start or get help on a project" | `/projects/create` for signed-in users, else `/login?return=/projects/create` |
| Volunteer | "Volunteer" | "Join our projects" | `/volunteer` |

### 4. Activity stream

- Heading: "Latest Project Activity"
- Below heading, three filter buttons (chip-style): All / Updates / Buzz — default All
- List of activity cards, newest first, 10 items, with "View all activity →" linking to `/project-updates`
- Each card is either a ProjectUpdate or a ProjectBuzz; rendering rules in [behaviors/activity-feed.md](../behaviors/activity-feed.md)

### 5. Help-wanted rail (new)

- Sidebar on the right at ≥ lg breakpoint, collapses below the activity stream at smaller breakpoints
- Heading: "Help Wanted"
- Up to 4 recent open `HelpWantedRole` cards. Each card shows:
  - Title
  - Project (link to project page)
  - `commitmentHoursPerWeek` if set, e.g., "~4 hrs/week"
  - Tags (small chips)
- "Browse all open roles →" links to `/help-wanted`

## Actions

| Action | Affects | Caused by |
| ------ | ------- | --------- |
| Hero CTA click | Navigation | "Volunteer" or "Browse Projects" button |
| Featured tile click | Navigation | Tile or title |
| Get-involved card click | Navigation | Whole card is clickable |
| Activity card click | Navigation | Card body links to project; "by <author>" links to person |
| Help-wanted card click | Navigation | Whole card links to project page, anchored to that role |
| Filter chip click | Local filter of activity stream | No re-fetch in v1 — client-side filter of the loaded 10 |

## Navigation

**To here:**

- Root URL `/`
- Logo / "home" link in app header from every other page

**From here:**

- `/volunteer`, `/sponsor`, `/projects`, `/projects/<slug>`, `/members/<slug>`, `/project-updates`, `/project-buzz`, `/help-wanted`, `/login`

## Authorization

| Section | Anonymous | User |
| ------- | --------- | ---- |
| Hero CTA | "Volunteer" | "Browse Projects" |
| Featured projects | visible | visible |
| Get involved | visible — "Start a Project" routes through `/login?return=/projects/create` | visible — "Start a Project" links to the in-app `/projects/create` form |
| Activity stream | visible | visible |
| Help-wanted rail | visible | visible — "Express interest" CTA on each card (deferred polish; v1 just links to project page) |

There are no staff- or admin-only home sections.

## Performance

This is the first impression. Inline-critical CSS for the hero; lazy-load below-fold sections; defer the activity stream and help-wanted rail to a post-FCP fetch.
