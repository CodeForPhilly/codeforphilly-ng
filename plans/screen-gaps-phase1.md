---
status: done
depends: []
specs:
  - specs/screens/project-detail.md
  - specs/behaviors/project-stages.md
  - specs/behaviors/app-shell.md
issues: [83]
pr: 102
---

# Plan: screen-gaps phase 1 — ProjectDetail + /contact wins

## Scope

[#83](https://github.com/CodeForPhilly/codeforphilly-ng/issues/83) is an
umbrella covering several spec-vs-implementation gaps across detail
screens. This plan closes the **SPA-only** quick wins so reviewers
aren't sitting on a single 1000-line PR:

1. **ProjectDetail "Share to Slack" button** — adds a button next to
   the existing "Copy link" that copies a pre-formatted Slack message
   to the clipboard (project title + URL).
2. **ProjectDetail "Edit on GitHub" footer link** — shown when
   `developersUrl` is a github.com URL. Small, muted link.
3. **ProjectDetail "What does this stage mean?" link + modal** —
   beside the Stage row in the Info sidebar; opens a dialog with the
   canonical descriptions from [behaviors/project-stages.md](../specs/behaviors/project-stages.md).
4. **`/contact` mailto link** — replaces the `<ComingSoon />`
   placeholder with the minimum the spec requires (`mailto:hello@codeforphilly.org`).

The Home "Start a Project" routing for signed-in users is **already in
place** (`apps/web/src/screens/Home.tsx:134`) — no work needed there
despite the audit listing it.

Out of scope for this phase (separate plans):

- **PersonDetail `email` + `slackHandle`** — needs a serializer
  change to surface `PrivateProfile.email` for self/staff and `Person.slackHandle`
  for everyone. Cross-cuts backend + frontend; treated as its own plan.
- **`/pages/:slug` content-files**
  ([behaviors/app-shell.md](../specs/behaviors/app-shell.md) Mission/Leadership/CoC/Hackathons)
  — needs `apps/web/src/content/pages/` directory with markdown files
  and the route to read+render. Treated as its own plan.
- **`/projects/:slug/buzz/new` create form** — needs a real form
  hooked into `POST /api/projects/:slug/buzz`. Treated as its own plan.

Closes only the SPA quick-wins of [#83](https://github.com/CodeForPhilly/codeforphilly-ng/issues/83).
Each of the deferred pieces gets its own plan.

## Implements

- [screens/project-detail.md](../specs/screens/project-detail.md) — Share/Info sidebar items + footer "Edit on GitHub" link.
- [behaviors/project-stages.md](../specs/behaviors/project-stages.md) — modal renders the canonical descriptions.
- [behaviors/app-shell.md](../specs/behaviors/app-shell.md) — `/contact` minimum is the mailto link.

## Approach

### 1. Share to Slack

A second button in the existing Share sidebar (line 392-407 of `ProjectDetail.tsx`). On click, copies a pre-formatted message to the clipboard:

```text
Check out <project.title> on Code for Philly: https://codeforphilly.org/projects/<slug>
```

Per spec: "opens a system share or copies a pre-formatted Slack message". Copying is the simpler shape and works in every browser without a native share API.

### 2. Edit on GitHub

Below the Info sidebar (the spec says "Footer"), but visually it fits at the bottom of the sidebar — a small muted link. Render only when `project.links.developersUrl` matches `https://github.com/...`. URL: same as `developersUrl`.

### 3. Stage modal

Beside the "Stage:" row in the Info sidebar, a "What does this stage mean?" link button opens a `<Dialog>` (shadcn) listing all seven stages with their canonical descriptions from [behaviors/project-stages.md](../specs/behaviors/project-stages.md). Highlights the project's current stage.

Stage descriptions go into a small constant in `apps/web/src/lib/project-stages.ts` (or wherever `StageBadge` lives) so they stay co-located with rendering.

### 4. /contact

Replace `<ComingSoon />` at the `/contact` route with a simple page rendering a heading + `mailto:hello@codeforphilly.org` link, matching the existing `Sponsor`/static page styling.

## Validation

- [x] ProjectDetail renders both "Copy link" and "Share to Slack" buttons.
- [x] ProjectDetail renders "Edit on GitHub" only when `developersUrl` is a github.com URL.
- [x] "What does this stage mean?" opens a modal listing all seven stages with descriptions, highlighting the current stage.
- [x] `/contact` is no longer a ComingSoon page — renders mailto link.
- [x] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **`navigator.clipboard.writeText` availability.** Modern browsers all support it in secure contexts; the existing Copy link button already uses it, so no new risk.
- **Stage modal copy drift.** The descriptions are duplicated between the spec and the SPA constant. If they diverge, the modal would lie. Mitigation: the constant cites the spec section in a comment so future-me knows where the source of truth lives.

## Notes

Three commits: plan-open, ProjectDetail enhancements, Contact page.

Surprises:

- **Stage descriptions already in `STAGES` constant.** `StageBadge.tsx`
  exports a `STAGES` record that already mirrors
  `specs/behaviors/project-stages.md` exactly — labels, descriptions,
  ranks, progress percentages, colors. The new modal just reads from
  this constant rather than introducing a parallel copy. The spec→
  code drift risk is bounded: any update to the spec only needs to
  touch one place in the SPA.
- **Home "Start a Project" was already correct.** The #83 audit
  listed it as a gap (the card should route signed-in users to
  `/projects/create`), but the code at `apps/web/src/screens/Home.tsx:134`
  already does exactly that. Marked the audit note as outdated in
  the plan rather than removing it — useful context for future-me
  to understand why no Home change appears in this PR.
- **GitHub URL detection via `new URL()`.** The naive
  `developersUrl.startsWith('https://github.com/')` check would miss
  `http://github.com/...` and accept `https://github.com.evil.com`.
  `URL.parse` + hostname check (`'github.com' || endsWith('.github.com')`)
  is the safer shape.
- **Web Share API not used.** Spec said "system share or copy". I
  considered `navigator.share` (gated by capability detection +
  fallback to copy) but the copy-only path is simpler, works in
  every browser, and the difference is invisible to users on
  desktop. If mobile usage starts mattering, swap in the Share API
  with copy as fallback.

## Follow-ups

- **Phase 2 — PersonDetail email + slackHandle.** Cross-cuts the API
  serializer (`apps/api/src/services/serializers/person.ts` needs to
  surface `PrivateProfile.email` for self/staff and `Person.slackHandle`
  for everyone) and the screen. Separate plan because it touches the
  permissions model. *Deferred to plan* — `plans/screen-gaps-phase2.md`
  to-be-written.
- **Phase 3 — `/pages/:slug` content rendering.** Requires
  `apps/web/src/content/pages/` directory with markdown for Mission,
  Leadership, CoC, Hackathons + a route that reads + renders them.
  *Deferred to plan* — `plans/static-pages.md` to-be-written.
- **Phase 4 — `/projects/:slug/buzz/new` create form.** Needs a real
  form bound to `POST /api/projects/:slug/buzz`. The API endpoint
  exists; just the SPA form is missing. *Deferred to plan* —
  `plans/buzz-new-form.md` to-be-written.
- **Web Share API integration.** The Share-to-Slack button could
  use `navigator.share` on mobile with copy fallback. *None* — not
  worth the gate logic until mobile usage data warrants it.
