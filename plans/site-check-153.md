---
status: in-progress
depends: []
specs:
  - specs/behaviors/app-shell.md
  - specs/screens/volunteer.md
issues: [153]
---

# Plan: site check — header order, mobile sheet padding, dead outbound links

## Scope

Issue [#153](https://github.com/CodeForPhilly/codeforphilly-ng/issues/153)
("Site check for desktop & mobile") collects a walkthrough of the live site on
both breakpoints. Four of its items are shippable now; one is blocked (see
Follow-ups).

What ships:

- **Desktop header reorder** (spec-governed). The Volunteer CTA leaves the
  content nav and becomes the rightmost element of the header, after the auth
  control; About joins the left cluster's text links; a GitHub icon link is
  added to the right cluster.
- **Mobile sheet padding + accessible name.** The sheet's nav and search sat
  flush against the panel edge. Fixed with the intended shadcn structure
  (`SheetHeader` + `SheetTitle`) plus explicit horizontal padding — which also
  gives the underlying Radix dialog the accessible name it was missing.
- **Header ARIA cleanups.** Three defects surfaced by an accessibility pass over
  the header, done here because this plan rewrites the same file.
- **Dead outbound links** (spec-governed). The whole `codeforphilly.gitbook.io`
  space returns 404 "Content owner not found"; `Volunteer.tsx`'s two remaining
  GitBook links are repointed at live equivalents. Same class of defect as
  [`home-start-project-cta`](home-start-project-cta.md) (PR #128), which fixed
  the Home screen's copy of the same dead URL.
- **Footer repo URL.** The "view this site on GitHub" link still pointed at
  `codeforphilly-rewrite`; the repo is `codeforphilly-ng` and the old URL only
  resolves through GitHub's rename redirect.

Explicitly out of scope:

- **Replacing the Home hero's Volunteer CTA with a mailing-list invite** (also
  recommended by #153) — blocked, see Follow-ups. `Home.tsx` is untouched.
- Any other visual restyle of the header. The Volunteer button keeps its
  existing green treatment; only its position changes.

## Implements

- [app-shell.md](../specs/behaviors/app-shell.md) — "Center / right at ≥ md"
  split into a left content cluster and a right utility cluster, with the new
  item order; "Auth controls" repositioned second-from-right; GitHub link added
  to the right cluster and to the mobile sheet; the sheet's accessible name
  added under Accessibility.
- [volunteer.md](../specs/screens/volunteer.md) — "Show up to meetups" card
  links to the Meetup group; "Start your own project" band links to the
  `CodeForPhilly/partnerships` first-steps guide. Both replace dead GitBook
  URLs.

## Approach

### 1. Spec changes first (specops — source of truth leads)

`specs/behaviors/app-shell.md` and `specs/screens/volunteer.md` both prescribed
the current (wrong) state, so they lead. Header spacing is deliberately *not*
specced — [specs/README.md:49](../specs/README.md) puts spacing outside spec
scope — so the mobile-sheet padding fix carries no spec change.

### 2. `apps/web/src/components/AppHeader.tsx`

- Left `<nav>`: Projects, Help Wanted, Members, About ▾. `gap-2` replaces
  `gap-1` + per-child `ml-1`, so the parent gap is the single source of spacing
  at the same effective density (4px + 4px → 8px).
- Right cluster: GitHub icon link → SearchBox → AuthControls → Volunteer button.
  New hand-rolled `GitHubIcon` SVG follows the file's existing icon convention
  (`ChevronDownIcon` / `MenuIcon`); path data copied from `LoginPlaceholder.tsx`.
- Mobile sheet: `SheetHeader` + `SheetTitle` ("Menu") replace the `pt-8` hack;
  nav and search get `px-4`. Mobile item order mirrors the new desktop order,
  with a GitHub row added and Volunteer last.
- ARIA: `aria-hidden` replaces `aria-label` on the roleless loading-skeleton
  div; the hand-written `aria-expanded` comes off the `SheetTrigger` (Radix
  `Dialog.Trigger` supplies it); `aria-label="About menu"` comes off the About
  trigger so its visible text is the accessible name. The account-menu
  `aria-label` **stays** — below `sm` the person's name span is `display:none`,
  so that label is the only accessible name there.

### 3. `apps/web/src/screens/Volunteer.tsx`

`HACK_NIGHT_URL` → `MEETUP_URL` = `https://www.meetup.com/Code-for-Philly/`
(the same target the footer's Meetup social icon already uses).
`START_PROJECT_URL` → the `CodeForPhilly/partnerships` first-steps markdown,
which is the surviving source of the retired GitBook page. Both stay external.

### 4. `apps/web/src/components/AppFooter.tsx`

One-line repo URL swap to `codeforphilly-ng`.

### 5. Tests

- `AppHeader.test.tsx` — new nav shape, About queried by its visible text, the
  GitHub link's label + href, Radix still supplying `aria-expanded`, and the
  sheet dialog's accessible name.
- `Volunteer.test.tsx` (new) — both CTA hrefs plus a dead-link regression
  assertion that no `codeforphilly.gitbook.io` URL survives anywhere in the
  rendered document, mirroring the idiom from `Home.test.tsx`.
- `AppFooter.test.tsx` — updated repo URL.

## Validation

- [ ] Specs updated before code: app-shell header clusters + volunteer link targets.
- [ ] Desktop header order is Projects · Help Wanted · Members · About ▾ … GitHub · Search · Sign in · Volunteer, with Volunteer rightmost and still green.
- [ ] No `ml-1` spacing hacks remain among the header nav's children.
- [ ] GitHub link is icon-only, labelled "Code for Philly on GitHub", and opens `https://github.com/CodeForPhilly` in a new tab with `rel="noopener noreferrer"`.
- [ ] Mobile sheet has a "Menu" title, horizontal padding on nav + search, and no `pt-8`; the title does not collide with the close button.
- [ ] The sheet dialog exposes an accessible name; Radix still supplies `aria-expanded` on the trigger.
- [ ] Loading skeleton uses `aria-hidden`; About trigger's accessible name is its visible text; account-menu label retained.
- [ ] Every mobile sheet item closes the sheet on click, including Contact.
- [ ] No `codeforphilly.gitbook.io` URL remains in `apps/web/src`.
- [ ] Footer "view this site on GitHub" points at `codeforphilly-ng`.
- [ ] `npm run -w packages/shared build && npm run type-check && npm run lint && npm test` clean.
- [ ] Browser test: desktop header order + mobile sheet padding at < md, both breakpoints.

## Risks

- **Low, but layout-shaped.** Moving Volunteer out of the flex-1 nav and into
  the `ml-auto` cluster changes how much room the SearchBox has to expand at
  narrow desktop widths. Watched by the browser-test criterion above rather
  than by a unit test — jsdom has no layout.
- **`aria-expanded` regression risk.** Removing the hand-written attribute is
  only safe because Radix supplies its own; asserted in the header test so a
  future primitive swap can't silently drop it.

## Notes

(To be populated at closeout.)

## Follow-ups

(To be populated at closeout. Known now:)

- **Tracked as: blocked — hero "mailing list invite" CTA.** Issue #153
  recommends replacing the Home hero's Volunteer CTA with a mailing-list
  invite. There is no anonymous mailing-list mechanism anywhere in the repo:
  newsletter subscription exists only as an auth-gated checkbox on `/account`
  (writing `PrivateProfile.newsletter`), and a public signup surface is
  explicitly deferred — [app-shell.md:140](../specs/behaviors/app-shell.md)
  lists "Newsletter signup (defer)" in the footer's Connect column, and
  [deferred.md:100-104](../specs/deferred.md) defers the whole newsletter
  sending pipeline with a promotion path (`/api/newsletter/send`, Resend-backed
  worker, unsubscribe tokens). Building an anonymous-capture CTA ahead of that
  spec would invent unspecified behavior. `Home.tsx` is deliberately untouched
  here; the CTA swap should follow the newsletter spec work, not precede it.
