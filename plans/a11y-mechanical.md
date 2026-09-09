---
status: done
depends: []
specs:
  - specs/behaviors/app-shell.md
issues: []
pr: 157
---

# Plan: mechanical accessibility fixes across the SPA

## Scope

The third and largest bucket of the `apps/web` accessibility audit: findings
with **one obviously-correct fix each** and no design decision attached.
Repeated button names in lists, heading-level skips, missing toolbar
semantics, unannounced status changes, dates trapped in `title` attributes,
missing new-tab cues, landmark nesting, and the `Breadcrumbs` component that
`specs/behaviors/app-shell.md` prescribes but nothing renders.

This branch **stacks on PR #154** (`fix/site-check-153` — header/nav rewrite)
and **PR #155** (`fix/aria-correctness` — ARIA validity), because it edits
many of the same files. It is cut from #154 with #155 merged in.

It **complements issue #156**, which holds the audit's *design-decision*
findings (colour contrast, `document.title`, motion/pause controls,
`CardTitle` semantics, the `NetworkErrorBanner` "Retry" contradiction).
Nothing from #156 is implemented here — those need decisions, not fixes.

Only one item is spec-facing, and it is conformance **to** an existing spec:
`specs/behaviors/app-shell.md` → Breadcrumbs already prescribes an exact
table of trails. **No spec change is needed anywhere in this plan.**

## Implements

- [app-shell.md](../specs/behaviors/app-shell.md) — **Breadcrumbs**: the
  prescribed trail table is brought to code on all six screens that declare
  one. The existing `Breadcrumbs.tsx` component was already correct and
  complete; it was simply never imported.

## Approach

### 1. Breadcrumbs wiring (the spec-conformance item)

`apps/web/src/components/Breadcrumbs.tsx` renders `nav[aria-label="Breadcrumb"]
> ol > li` with `aria-current="page"` on the last crumb — correct as written,
imported by nothing. Wired into the six screens the spec's table names, each
rendered as a fragment sibling immediately *above* the screen's content
container (the spec's "row below the header"):

| Route | Trail |
|---|---|
| `/projects/:slug` | Projects › `<title>` |
| `/projects/:slug/edit` | Projects › `<title>` › Edit |
| `/projects/create` | Projects › New project |
| `/members/:slug` | Members › `<fullName>` |
| `/tags/:namespace/:slug` | Tags › `<namespace>` › `<title>` |
| `/account` | Settings |

No `specs/screens/*.md` mentions breadcrumbs at all, so there is no
contradiction to resolve — app-shell.md is the sole authority.

### 2. Repeated identical button names in lists (SC 4.1.2 / 2.4.6)

A screen-reader user tabbing a list of "Remove / Remove / Remove" has no way
to tell the rows apart. Each gets an `aria-label` that **contains its visible
text** (SC 2.5.3) plus the row's subject:

| File | Buttons | Label shape |
|---|---|---|
| `modals/ManageMembersModal.tsx` | Edit role, Make maintainer, Remove | `Remove ${fullName}` |
| `screens/Account.tsx` | Revoke (per session) | `Revoke session on ${device}` |
| `pages/StaffAccountClaimQueue.tsx` | Approve, Deny | `Approve claim from ${login}` |
| `screens/ProjectDetail.tsx` | Mark filled, Close | `Close ${role.title}` |

### 3. Heading levels

Three index screens jump `h1` → `h3` because their card components render
`h3`. **The cards are not changed** — `PersonCard` and `HelpWantedCard` are
each used in a second context (`TagDetail`, `Home`, `Volunteer`) where they
sit correctly under a section `h2`. Instead each index screen gains an
`sr-only <h2>` section heading above its results region, which is both the
smaller change and the more honest markup: the grid *is* a section.

`ProjectDetail` and `PersonDetail` aside headings go `h3` → `h2` directly —
they sit under the screen `h1` with no intervening heading, are used nowhere
else, and keep their existing classes so nothing moves visually. (Heading
level and visual size are independent.)

`ProjectsIndex` was checked for the same pattern and does **not** have it —
`ProjectCard` already renders `h2`. No sr-only heading added there.

### 4. `MarkdownEditor` toolbar

The six formatting buttons were a bare `<div>` of buttons named "B", "I",
"Link"… Now `role="toolbar"` + `aria-label="Formatting"`, each button
`aria-label`'d with a full name that contains its visible label as a
substring (B ⊂ Bold, I ⊂ Italic, Link ⊂ Insert link, List ⊂ Bulleted list),
and a roving tabindex: only the active button is tabbable,
ArrowLeft/ArrowRight move focus (wrapping), Home/End jump to the ends. The
keydown handler derives its starting index from the event target rather
than the `activeButton` state, which lags a focus change by one render.

### 5. Status announcements

Three places changed state visually with nothing announced:

- `ProjectDetail` "Copy link" / "Share to Slack" gave **no feedback at all** —
  now `toast.success(...)` via sonner, which this screen's own modals already
  use for exactly this kind of confirmation.
- `Sponsor`'s "Copy email" swaps its label to "Copied ✓" — visible text kept,
  with an `sr-only role="status"` mirror added.
- `ProfileEdit`'s "Uploading…" span becomes `role="status"`.
- `ConnectGitHubBanner` is a `role="region"` that mounts only after auth
  resolves, so its arrival is never announced. It *stays* a region (a
  late-mounted `status` container is not read reliably either, and it would
  wrap the two buttons) and gains a sibling sr-only `role="status"` span
  carrying the headline — the same mirror idiom as `Sponsor`.

### 6. `<time dateTime>` for machine-readable dates

`title` is not exposed to most screen readers and never on touch. Every date
rendered as relative text inside a `title`-only `<span>` becomes
`<time dateTime={iso} title={absolute}>` — the `BlogIndex.tsx` idiom.
Covers `ActivityCard` (×2), `ProjectDetail` (×2), `PersonDetail` (×2),
`HelpWantedCard`, `BlogDetail`, `Account`, `StaffAccountClaimQueue`,
`AccountClaim`. `ProjectCard`'s wrapper
`title={m.fullName}` is deleted outright — `PersonAvatar` already emits it.

### 7. Structure and one-liners

- `PersonCard` was one giant `<Link>`, so its accessible name concatenated
  avatar + name + project count + every tag chip. Restructured to the
  `ProjectCard` idiom: `<article>` with the `h3` wrapping the link. The hover
  lift (`hover:shadow-md hover:-translate-y-0.5`) stays on the article, so
  the affordance is unchanged.
- `AppHeader`'s two navs render bare links; wrapped in `<ul>/<li>` matching
  `AppFooter`. Flex/gap classes move to the `ul`; `li` contributes nothing.
  Sheet separators sit between the two lists rather than inside one.
- The mobile sheet's "About" group label was a styled `<p>` → `<h3>` (one
  level below the Radix `SheetTitle`, which renders `h2`), same classes.
- `HelpWantedIndex`'s bare outer `<aside>` wrapped `FacetSidebar`, which
  renders its own labelled `<aside>` — two nested `complementary` landmarks.
  `FacetSidebar` now accepts `children` inside its aside, and the Commitment
  heading + fieldset ride there: one landmark ("Filters") holds every filter
  control instead of leaving Commitment orphaned beside it. (`PeopleIndex`/
  `ProjectsIndex` render `FacetSidebar` directly and never had this.)
- Result-count badges move **out** of the `h1` into a flex sibling on all
  three index screens, so the heading's accessible name stops mutating as
  filters change.
- `target="_blank"` links get a new-tab cue: `<span className="sr-only"> (opens
  in new tab)</span>` where visible text exists, appended to the `aria-label`
  where it does not.
- `ProjectDetail`'s "More ▾" menu trigger gets `aria-label="More actions"`;
  the "What does this stage mean?" dialog trigger gets `aria-haspopup="dialog"`.

## Validation

- [x] Breadcrumbs render on all six screens the spec's table names, with the
      exact trails prescribed, and each non-final crumb links to its parent.
- [x] No two buttons in the audited lists share an accessible name; every
      added `aria-label` contains the button's visible text (SC 2.5.3).
- [x] `PeopleIndex` / `HelpWantedIndex` no longer skip `h1` → `h3`;
      `ProjectDetail` / `PersonDetail` aside headings are `h2`.
- [x] The `MarkdownEditor` toolbar exposes `role="toolbar"`, named buttons,
      and a working roving tabindex (Arrow/Home/End).
- [x] Copy actions on `ProjectDetail` and `Sponsor` announce (including a
      failure toast where `navigator.clipboard` is absent); `ProfileEdit`'s
      upload is a live region; `ConnectGitHubBanner`'s arrival is announced
      by its sibling status span.
- [x] Dates expose `datetime`; no date is `title`-only.
- [x] Exactly one `complementary` landmark per index screen, and on
      `HelpWantedIndex` it contains the Commitment controls
      (`HelpWantedIndex.test.tsx`).
- [x] Full gate from the repo root, all workspaces: `npm ci && npm run -w
      packages/shared build && npm run type-check && npm run lint && npm
      test` clean after the rebase onto `develop` and the review fix-ups
      (api 434/434 across 35 files, web 124/124 across 28, shared 75/75
      across 3). The root `npm test` invocation was OOM-killed once on the
      closeout machine, so the api suite was re-run alone with
      `--maxWorkers=2`; every workspace suite ran to completion. The
      contributor's earlier pass ran web + shared only (web 116/116,
      shared 75/75).
- [x] Browser test (headed Chrome against the live dev stack — api booted on
      a `setup-dev-data` repo with two seeded records): breadcrumb trails
      verified on `/projects/qa-sandbox` ("Projects › QA Sandbox Project")
      and `/members/ada-tester` ("Members › Ada Tester"); "Copy link" fires
      the "Link copied" toast; the count badge sits outside the `h1` with
      the visual unchanged; `PersonCard` whole-card click still navigates.
      Toolbar keyboard nav verified in jsdom only (`MarkdownEditor.test.tsx`).

## Risks / unknowns

- **Low.** Almost every change is attribute-level or a wrapper element.
- The two structural edits (`PersonCard`, `AppHeader` nav lists) touch files
  PR #154 rewrote. Both keep every existing behavior — the sheet closing on
  navigation (derived from `location.key` since #154, so the NavLinks carry
  no per-item `onClick`), the separators, the NavLink active styling — and
  are covered by the existing `AppHeader.test.tsx` suite plus updated name
  matchers.
- The `apps/api` suite was skipped on the contributor's Windows pass (known
  fixture failure there, tracked in #162); it was run in full on Linux at
  closeout — see Validation.

## Notes

- **`aria-label` supersets on visible-text buttons are deliberate.** "More ▾"
  → `aria-label="More actions"`, "Mark filled" → `Mark filled: <role>`,
  "Remove" → `Remove <name>`, and the toolbar's "B" → "Bold". In every case
  the visible text is a prefix (or, for the toolbar, a substring) of the
  accessible name, which is what SC 2.5.3 Label in Name asks for and what
  the specs already assume for the per-row actions. Speech-input users
  saying what they see still hit the control.
- **jsdom's accname drops the leading space in sr-only cues** — it
  computes `"GitHub(opens in new tab)"` where Chrome computes
  `"GitHub (opens in new tab)"`. Tests match with `\s*` regexes rather than
  encoding either engine's answer.
- **Rebase.** The branch was cut from a local merge of #154 and #155; both
  were patched during review before landing on `develop`, so the eight
  commits here were rebased onto `develop` after #155 merged. The one
  conflict was `AppHeader.tsx`: #154 replaced the per-NavLink `onClick`
  closers with a sheet state derived from `location.key`, and this branch
  wrapped the same links in `<ul>/<li>`. Resolved by keeping the list
  structure without the closers (the two plain `<a>`s — Contact, GitHub —
  keep theirs, since they don't navigate client-side).
- **Review fix-ups applied on top of the six commits:** `block` on sheet
  anchors so the `<li>` wrap doesn't shrink their tap targets; Commitment
  moved inside `FacetSidebar`'s aside (via a new `children` slot) instead
  of sitting outside every landmark; `ConnectGitHubBanner` kept as a region
  with a sibling status announcer; `Breadcrumbs` keyed by index (the PR's
  own "pre-existing, flagged" item); the namespace crumb labelled via
  `TagsNamespace`'s `NS_LABELS` so it matches the destination `h1`;
  `ProjectEdit` holds its loading state when the edit query settles empty
  instead of rendering a blank crumb to `/projects/`; a `copyWithToast`
  helper on `ProjectDetail` that guards `navigator.clipboard` (undefined in
  insecure contexts, and reading `.writeText` off it throws synchronously,
  so the old `.catch()` never fired); `ProfileEdit`'s status span only
  reserves `mt-1` while it has text; three `<time>`s the first sweep missed
  (`HelpWantedCard`, `PersonDetail` ×2); the toolbar keydown handler reads
  its index from the event target rather than the `activeButton` closure.
- `NS_LABELS` is now exported from `screens/TagsNamespace.tsx` and imported
  by `screens/TagDetail.tsx` — a screen importing from a screen, chosen as
  the smallest change. `FacetSidebar` carries its own copy of the same map;
  a shared tags-label module could absorb both.

## Follow-ups

- Issue [#166](https://github.com/CodeForPhilly/codeforphilly-ng/issues/166)
  — render breadcrumbs from the shell via route `handle`s (`useMatches`)
  per app-shell.md, so skip-to-main lands past them rather than on them.
- Issue [#167](https://github.com/CodeForPhilly/codeforphilly-ng/issues/167)
  — `ExternalLink` component for the 16 hand-rolled "(opens in new tab)"
  copies.
- Issue [#168](https://github.com/CodeForPhilly/codeforphilly-ng/issues/168)
  — `RelativeTime` component for the 13 `<time dateTime title>` sites.
- Issue [#169](https://github.com/CodeForPhilly/codeforphilly-ng/issues/169)
  — `MarkdownEditor` toolbar should use Radix `Toolbar` from the
  already-installed `radix-ui` instead of the hand-rolled roving tabindex.
- Issue [#170](https://github.com/CodeForPhilly/codeforphilly-ng/issues/170)
  — card heading level should be a prop; `TagDetail` renders a section `h2`
  followed by `ProjectCard` `h2`s.
