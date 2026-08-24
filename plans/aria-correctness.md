---
status: in-progress
depends: []
specs:
  - specs/behaviors/app-shell.md
issues: []
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
brought into conformance with an existing spec — **no spec change is needed**.

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
- ArrowDown/ArrowUp (wrapping), Home/End, Enter, Escape; focus never leaves
  the input, so the blur race is structurally gone for keyboard users. The
  popup swallows `mousedown` so a pointer click cannot blur the input either —
  the 150 ms timeout is deleted rather than tuned.
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
Backspace-removes-last is preserved.

### 3. Small repairs

| File | Defect | Fix |
|---|---|---|
| `PersonAvatar.tsx` | `aria-label` on a roleless `<span>` (prohibited) | `role="img"` |
| `StageBadge.tsx` | `aria-label` on a roleless `<div>`; progress conveyed by width only; tooltip triggers not focusable | `role="progressbar"` + value attrs; `tabIndex={0}` on both triggers |
| `LoginPlaceholder.tsx`, `AccountClaim.tsx` | `aria-live` + `aria-label` on an empty roleless div announces nothing | `role="status"` + `sr-only` text, spinner `aria-hidden` |
| `NetworkErrorBanner.tsx` | button reads "Retry", `aria-label` says "Dismiss error" (SC 2.5.3) | drop the `aria-label` |
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

- [ ] `SearchBox` exposes `role="combobox"` with `aria-expanded`,
      `aria-controls`, `aria-autocomplete="list"`; the listbox owns only
      groups/options; status text sits outside it.
- [ ] `SearchBox` keyboard: type → ArrowDown moves `aria-activedescendant` →
      Enter navigates to the active option; Escape closes.
- [ ] `TagPicker` label is associated with its input; ArrowDown + Enter
      selects an option; Escape closes; Backspace-removes-last still works.
- [ ] New tests `apps/web/tests/SearchBox.test.tsx` and
      `apps/web/tests/TagPicker.test.tsx` cover the above.
- [ ] No `aria-label` remains on a roleless generic element in the audited set.
- [ ] Every audited `aria-invalid` control references its error text via
      `aria-describedby`.
- [ ] `npm run -w packages/shared build && npm run type-check && npm run lint
      && npm test` clean.

## Risks

- **Medium, contained to two widgets.** The SearchBox and TagPicker rewrites
  change interaction, not just attributes. Both are covered by new focused
  tests; both keep their existing Tailwind classes so the visual design is
  unchanged.
- The rest is attribute-level and mechanical.

## Notes

_(filled in at closeout)_

## Follow-ups

- **Spec↔code contradiction, surfaced not patched — the 5xx banner's "Retry"
  button does not retry.** `NetworkErrorBanner`'s button calls `clearError()`
  and nothing else: it dismisses the banner. Its visible text says "Retry" and
  `specs/behaviors/app-shell.md:162` prescribes `[Retry]`, so spec and label
  agree with each other and both disagree with the code. This plan only
  removed the `aria-label="Dismiss error"` that contradicted the visible name
  (SC 2.5.3) — note that the removed label was the one place the code admitted
  what the button actually does. Resolving the contradiction is a behavior
  question, not an ARIA one: either the banner gains a real retry (re-issuing
  the failed call, which the context does not currently retain) or the spec and
  label change to "Dismiss". Needs its own spec decision and plan; do not
  settle it by renaming one side.
- The audit surfaced further categories that are **not** ARIA-correctness
  defects and were deliberately excluded here — heading hierarchy, colour
  contrast, `document.title`, motion/pause controls, breadcrumbs,
  `target="_blank"` cues, toolbar semantics, repeated button names, and
  `CardTitle` semantics. The coordinator holds the full audit report; these
  want their own triage and plan.
