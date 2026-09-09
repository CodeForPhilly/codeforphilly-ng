---
status: done
depends: []
specs:
  - specs/behaviors/app-shell.md
  - specs/screens/volunteer.md
issues: [153]
pr: 154
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

- [x] Specs updated before code: app-shell header clusters + volunteer link targets.
- [x] Desktop header order is Projects · Help Wanted · Members · About ▾ … GitHub · Search · Sign in · Volunteer, with Volunteer rightmost and still green.
- [x] No `ml-1` spacing hacks remain among the header nav's children.
- [x] GitHub link is icon-only, labelled "Code for Philly on GitHub", and opens `https://github.com/CodeForPhilly` in a new tab with `rel="noopener noreferrer"`.
- [x] Mobile sheet has a "Menu" title, horizontal padding on nav + search, and no `pt-8`; the title does not collide with the close button.
- [x] The sheet dialog exposes an accessible name; Radix still supplies `aria-expanded` on the trigger.
- [x] Loading skeleton uses `aria-hidden`; About trigger's accessible name is its visible text; account-menu label retained.
- [x] Every mobile sheet item closes the sheet on click, including Contact.
- [x] No `codeforphilly.gitbook.io` URL remains in `apps/web/src`.
- [x] Footer "view this site on GitHub" points at `codeforphilly-ng`.
- [x] Both replacement URLs return 200 and carry the expected content.
- [x] `npm run -w packages/shared build`, `npm run type-check`, and `npm run lint` clean.
- [x] `npm test` clean for the workspaces this plan touches: web 98/98, shared 75/75.
- [x] `npm test` clean for **all** workspaces — api 434/434 on Linux at review (the Windows dev box could not run it, see Notes). Two web files (`ProjectEdit`, `ExpressInterestModal`, neither touched here) hit 5s timeouts under full-suite load and pass when run alone.
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

- **Browser criterion left unchecked.** What was exercised: desktop header
  order, spacing, GitHub icon, and Volunteer-rightmost in headed Chrome at
  1400px; the sheet opened via its CSS-hidden trigger at desktop width ("Menu"
  title, padded nav/search, no title/close collision, Escape closes it); and,
  at review, headless Chrome at 768/1023/1024px for the tablet band (below).
  What was not: the sheet and the < md header bar at an actual < md viewport.
  The sheet is not a fixed-width portal — `ui/sheet.tsx` sizes it
  `w-3/4` of the viewport capped at `sm:max-w-sm` — so its desktop-width
  rendering is not evidence for < md. Same gap `web-shell.md:109` recorded;
  covered by issue [#16](https://github.com/CodeForPhilly/codeforphilly-ng/issues/16).
- **Sheet closes on navigation, not per item.** Review found the eleven
  hand-wired `onClick={() => setMobileOpen(false)}` closers missed the inline
  SearchBox's Enter path. Replaced with one rule: `mobileOpen` is derived as
  "opened at the current `location.key`", so any client-side navigation
  (NavLink, search Enter, same-path re-click) closes it. Derived during render
  rather than a `useLocation` effect because `react-hooks/set-state-in-effect`
  (in the plugin's v7 recommended set) flags the effect form — same
  state-sync pattern `ProjectEdit.tsx` uses. Explicit closers remain only on
  the two anchors that don't change location (Contact `mailto:`, GitHub
  new-tab). Two tests cover a NavLink click and the search Enter path.
- **Tablet band (768–1023px) overflowed.** Tailwind's `container` is 768px
  wide across that whole range (736px content box). Measured at 768: logo 128
  - nav 297 + gaps/margins 48 + utility cluster 387 = 860, so the document
  scrolled to 845px and "Help Wanted" wrapped. Fix: GitHub icon link is
  `hidden lg:inline-flex` (the sheet keeps its own row) and the desktop
  SearchBox is `w-24 lg:w-48 lg:focus-within:w-72`. Its results dropdown is
  now anchored `right-0 min-w-72` instead of `left-0 right-0`, so it stays
  288px wide over the narrow input — the same width it had at `lg` before.
  After: 728px used at 768 (no scroll, one-line nav); 1024 fits with the icon
  and 192px search restored. Signed-in accounts still overflow this band
  (pre-existing, see Follow-ups).
- **Mobile sheet dialog.** Radix warned on every open about a missing
  description; a visually-hidden `SheetDescription` ("Site navigation") now
  satisfies `aria-describedby`. The `className="w-72"` on `SheetContent` was
  dead (the primitive's `data-[side=right]:w-3/4` / `sm:max-w-sm` win) and is
  gone; the plan's earlier "fixed `w-72`" claim was wrong.
- **Utility landmark.** The desktop utility cluster is `<nav aria-label="Utility">`
  so Volunteer and GitHub stay inside a navigation landmark after leaving
  "Primary navigation"; app-shell.md's Accessibility section names both.
- **`GitHubIcon` lifted** to `apps/web/src/components/icons/GitHubIcon.tsx`;
  the byte-identical copies in `AppHeader.tsx` and `LoginPlaceholder.tsx` now
  import it. (Approach §2 above describes the copy as originally planned.)
- **`HomeStub.tsx` removed** here after all — zero importers (grep-verified),
  dead since scaffold. The same stale `codeforphilly-rewrite` GitHub URL was
  also repointed in `specs/architecture.md`, `specs/behaviors/storage.md`, and
  `docs/operations/cutover-announcement.md` (a hard 404, unlike the k8s
  namespace / package name uses of the old slug, which are left alone).
- **`Volunteer.test.tsx` act warnings.** Three synchronous tests returned
  before `AuthProvider`'s `/api/auth/me` fetch resolved; each now awaits the
  settled DOM like the fourth test.
- **`apps/api` tests do not pass on Windows, independent of this plan.**
  `apps/api` finishes 3 failed | 30 passed (33 files), 10 failed | 413 passed
  (423 tests) — the ten spread across `scrub-data.test.ts` (4),
  `internal-reload.test.ts` (4), and `store.test.ts` (2), on a tree where
  `git diff develop..HEAD -- apps/api packages/` is empty — this branch touches
  no API code. Checking out `develop` and re-running `store.test.ts` there
  reproduces its 2 failed | 11 passed exactly. The mechanism is
  POSIX-isms in the test fixtures: `store.test.ts` injects a write failure by
  pointing the private store at `/dev/null/impossible-path` and asserting the
  transaction rejects, but on Windows that is an ordinary creatable directory,
  so the write succeeds and the expected throw never happens. They reproduce
  with the files run alone, so it is not test-runner contention. CI runs the
  same gate on Linux, where the fixture behaves as intended. Worth a
  cross-platform fixture cleanup if Windows dev boxes are to be supported;
  filed under Follow-ups.

## Follow-ups

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

- Issue [#162](https://github.com/CodeForPhilly/codeforphilly-ng/issues/162) — make
  the `apps/api` test fixtures cross-platform. The `/dev/null` failure-injection
  idiom (and whatever the other seven failures share) makes the API suite
  unrunnable on a Windows dev box, so the documented validation gate can only be
  completed on Linux or in CI. See Notes for the mechanism.

- Issue [#163](https://github.com/CodeForPhilly/codeforphilly-ng/issues/163) — the
  signed-in header (avatar + full name + caret) still overflows the 768–1023px
  band; predates this plan and needs a breakpoint the shared `AuthControls`
  can apply to the desktop cluster only.
