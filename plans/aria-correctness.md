---
status: done
depends: []
specs:
  - specs/behaviors/app-shell.md
issues: [164, 165]
pr: 155
---

# Plan: repair invalid and missing ARIA across the SPA

## Scope

An accessibility audit of `apps/web` turned up a set of **verified ARIA
correctness defects** — markup that is invalid per the ARIA spec (prohibited
attributes, illegal role ownership, dangling references) or that withholds
state from assistive technology that sighted users get visually. This plan
fixes that class of defect only.

The two headline items are the site search box and the tag picker: both claim
`role="listbox"` today while owning non-option children, and neither is
operable from the keyboard. `specs/behaviors/app-shell.md` → Accessibility
already requires "All dropdowns are keyboard-navigable", so this is code
brought into conformance with an existing spec. Review surfaced two places
where the spec's own wording lagged the widget (Enter's behaviour with a
highlighted result; what the error banner's Retry does) — those were amended
in the spec first, then the code followed.

Out of scope by deliberate choice: heading hierarchy, colour contrast,
`document.title`, motion/pause controls, breadcrumbs, `target="_blank"` cues,
toolbar semantics, repeated button names, `CardTitle` semantics. See
[Follow-ups](#follow-ups).

## Implements

- [app-shell.md](../specs/behaviors/app-shell.md) — **Accessibility** section,
  partially: "All dropdowns are keyboard-navigable" now holds for the header
  search box and the tag picker. The remaining bullets (logo link, skip link,
  mobile sheet focus trap) were already satisfied; the skip link's focus ring
  is restored here.

## Approach

### 1. `SearchBox` — rebuild as an APG combobox

`apps/web/src/components/SearchBox.tsx` was invalid on every axis: it put
`aria-expanded`/`aria-controls` on an implicit `searchbox`, gave the popup
`role="listbox"` while it owned a bare `<p>` and unroled `<div>`s, hardcoded
`aria-selected={false}` on every option, and was unreachable by keyboard — Tab
blurred the input and a 150 ms `setTimeout` unmounted the popup, so only Enter
and Escape ever worked.

Rebuilt to the [ARIA APG combobox-with-listbox
pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/):

- Input carries `role="combobox"`, `aria-expanded`, `aria-controls`,
  `aria-autocomplete="list"`, and `aria-activedescendant`.
- Group headers become `role="group"` + `aria-labelledby` → a
  `role="presentation"` header element, so the listbox owns only
  groups and options.
- "Searching…" / "No results" moves **out** of the listbox into a sibling
  `role="status"` region.
- "See all results" becomes the final option in the listbox.
- ArrowDown/ArrowUp (wrapping), Enter, Escape; focus never leaves the input
  while the popup is open, so the blur race is structurally gone for keyboard
  users. Home/End are left to the text caret (APG: editable combobox). The
  popup swallows `mousedown` so a pointer click cannot blur the input either —
  the 150 ms timeout is deleted rather than tuned. Activating a result blurs
  the input so focus returns to the page.
- Options track the pointer with a guarded `onMouseMove`, not `onMouseEnter`,
  so results arriving under a stationary pointer cannot steal a keyboard
  user's highlight.
- The inline (mobile-sheet) instance renders results in-flow with a smaller
  height cap; absolutely positioned, they hung below the sheet's fixed-height
  viewport on short phones.
- Options stay `<a href>` (valid: `option` is an allowed role for `a[href]`)
  with `tabIndex={-1}`, so middle-click / "open in new tab" still work, while
  a plain click is intercepted and routed through `useNavigate()` instead of
  doing a full-page reload.
- The popup's hardcoded `id="search-results-dropdown"` is replaced by
  `useId()`-derived ids. That id was duplicated whenever both the desktop and
  the mobile-sheet instance rendered; the print stylesheet's hook moves to
  `[data-search-dropdown]` to keep `specs/behaviors/app-shell.md` → Print true.

### 2. `TagPicker` — same combobox pattern

`apps/web/src/components/TagPicker.tsx` had `role="listbox"` on a `<ul>` whose
`<li>`s carried no role and wrapped `<button>`s, no combobox ARIA on the
driving input, no Escape/arrow handling, and a `label` prop that rendered a
`<Label>` associated with nothing (affecting ProjectEdit, ProfileEdit and
PostHelpWantedModal). Reworked to the same pattern: `useId()` ties `<Label
htmlFor>` to the input; `<li role="option">` become the interactive targets;
ArrowDown/ArrowUp/Escape/Enter. Enter falls back to the existing
exact-match → first-match → create-tag chain when no option is active, and
Backspace-removes-last is preserved. The list closes on focus-out (container
`onBlur` + `relatedTarget` check, options `tabIndex={-1}`) rather than via a
document-level mousedown listener, and the input reopens it on click since a
mouse selection leaves focus in place.

### 3. Small repairs

| File | Defect | Fix |
| --- | --- | --- |
| `PersonAvatar.tsx` | `aria-label` on a roleless `<span>` (prohibited) | `role="img"` |
| `StageBadge.tsx` | `aria-label` on a roleless `<div>`; progress conveyed by width only; stage description tooltip-only | `role="progressbar"` + value attrs; description exposed via `sr-only` text / `aria-describedby` (no extra tab stop) |
| `LoginPlaceholder.tsx`, `AccountClaim.tsx` | `aria-live` + `aria-label` on an empty roleless div announces nothing | `role="status"` + `sr-only` text, spinner `aria-hidden` |
| `NetworkErrorBanner.tsx` | button reads "Retry", `aria-label` says "Dismiss error" (SC 2.5.3), and the handler only dismissed | drop the `aria-label`; `showError` takes a retry callback (query client re-fetches active queries); label reads "Dismiss" when there is none |
| `TagChip.tsx` | `aria-pressed` on every clickable chip made filter-removal chips announce as toggles | emit it only when `active` is passed |
| `PersonAvatar.tsx` | Link `aria-label` duplicated the inner `role="img"` name | drop it; the link is named by content |
| `TopProgressBar.tsx` | progressbar permanently exposed at 100% | `aria-hidden` when idle |
| `TagChip.tsx`, `Home.tsx` | toggle state conveyed visually only | `aria-pressed` |
| `ConnectGitHubBanner.tsx` | `aria-label` duplicates visible text | removed |
| `MarkdownEditor.tsx` | `aria-live` re-announces the whole preview each debounce; error text unassociated | drop `aria-live`; `aria-describedby` |
| `ManageMembersModal.tsx` | placeholder-only labelling | `aria-label="Role"` |
| `ProfileEdit.tsx` | "Avatar" `<Label>` labels nothing | `htmlFor` → file input `id` |
| `ProjectsIndex.tsx`, `HelpWantedIndex.tsx` | filter chips don't say they remove | `aria-label="Remove filter: …"` |
| `Pagination.tsx` | page buttons named only "3" | `aria-label="Page 3"` |
| `Account.tsx` | sessions table headers have no scope | `scope="col"` |
| `AppShell.tsx` | skip link ends with `focus:outline-none` | class removed |
| `ProjectEdit.tsx` | async slug availability never announced | `role="status"` + `aria-describedby` |

### 4. Form error wiring (systemic)

`aria-invalid` was set in several forms but the error text was never
programmatically associated, so a screen-reader user hears "invalid" with no
reason. Every error `<p>` gains an `${id}-error` id and its control gains a
conditional `aria-describedby`, applied uniformly across `AddMemberModal`,
`ProjectEdit` (5 fields), `ProjectBuzzNew` (4), `PostHelpWantedModal`,
`TagEditModal` (2) and `ProfileEdit` (2).

## Validation

- [x] `SearchBox` exposes `role="combobox"` with `aria-expanded`,
      `aria-controls`, `aria-autocomplete="list"`; the listbox owns only
      groups/options; status text sits outside it.
- [x] `SearchBox` keyboard: type → ArrowDown moves `aria-activedescendant` →
      Enter navigates to the active option; Escape closes.
- [x] `TagPicker` label is associated with its input; ArrowDown + Enter
      selects an option; Escape closes; Backspace-removes-last still works.
- [x] New tests `apps/web/tests/SearchBox.test.tsx` and
      `apps/web/tests/TagPicker.test.tsx` cover the above.
- [x] No `aria-label` remains on a roleless generic element in the audited set.
- [x] Every audited `aria-invalid` control references its error text via
      `aria-describedby`.
- [x] `npm run -w packages/shared build && npm run type-check && npm run lint
      && npm test` clean.

## Risks

- **Medium, contained to two widgets.** The SearchBox and TagPicker rewrites
  change interaction, not just attributes. Both are covered by new focused
  tests; both keep their existing Tailwind classes so the visual design is
  unchanged.
- The rest is attribute-level and mechanical.

## Notes

- **Mousedown swallow vs. focus-out.** `SearchBox` keeps the
  `onMouseDown={preventDefault}` on its popup and closes on input blur — the
  options are `<a href>`s and focus should stay in the input until a result is
  chosen. `TagPicker` went the other way after review: container `onBlur` with
  a `relatedTarget` check, `tabIndex={-1}` on the listbox and options, and no
  swallow, because the swallow blocked scrollbar dragging in Firefox and kept
  the input focused so a second click could never reopen the list. The two
  widgets now differ here; see the combobox-hook follow-up.
- **Hardcoded error ids kept.** The `aria-describedby` wiring in §4 uses
  literal ids (`title-error`, `slug-error`, …). They collide when a screen and
  a modal that share one are mounted together. Left as-is to keep this PR
  attribute-level; tracked as a follow-up.
- **Review pass (post-#154 rebase).** Home/End removed from `SearchBox`
  (APG: editable combobox leaves them to the caret); `activate()` blurs the
  input; option highlight moves on guarded `onMouseMove`; inline results
  render in-flow so the mobile sheet can scroll them; `TagChip` only emits
  `aria-pressed` when `active` is passed; `StageBadge`/`StageProgressBar`
  lost their `tabIndex={0}` in favour of `sr-only` / `aria-describedby`
  descriptions; `PersonAvatar`'s link label dropped (double announcement);
  the error banner's Retry now re-fetches active queries and reads
  "Dismiss" when there is nothing to retry. `specs/behaviors/app-shell.md`
  was amended first for the Enter/arrow-key contract and the Retry
  semantics. `apps/web` `testTimeout` raised to 15 s — several screen tests
  exceeded 5 s under full-suite load.
- **Mobile-sheet layout was reasoned, not screenshotted.** No API/data repo
  was available in the review environment for a headless check; the in-flow
  change follows from the sheet being a fixed-height flex column whose nav
  has `min-h-0 overflow-y-auto`, so an in-flow, self-scrolling results box
  (`max-h-64`) stays inside the viewport while the nav yields height.
- The AppHeader test from #154 queried the sheet search as a `searchbox`;
  it is a `combobox` now, and a second case covers clicking a result closing
  the sheet via #154's `location.key` mechanism.

## Follow-ups

- Issue [#164](https://github.com/CodeForPhilly/codeforphilly-ng/issues/164) —
  form error ids should derive from `useId()`; the hardcoded `title-error` /
  `slug-error` ids collide when a screen and a modal are mounted together.
- Issue [#165](https://github.com/CodeForPhilly/codeforphilly-ng/issues/165) —
  extract a shared combobox hook for `SearchBox` / `TagPicker`; the two
  hand-rolled copies have already diverged on close-on-blur handling.
- The 5xx banner's "Retry" spec↔code contradiction recorded at the original
  closeout was resolved in review: spec amended first, a real retry wired
  (re-fetch active queries), and the label reads "Dismiss" when nothing can be
  retried. Nothing outstanding.
- Tracked as: the wider audit categories deliberately excluded here — heading
  hierarchy, colour contrast, `document.title`, motion/pause controls,
  breadcrumbs, `target="_blank"` cues, toolbar semantics, repeated button
  names, `CardTitle` semantics. The coordinator holds the full audit report;
  these want their own triage and plan.
