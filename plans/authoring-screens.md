---
status: done
depends: [public-screens, write-api]
specs:
  - specs/screens/project-edit.md
  - specs/screens/account.md
  - specs/screens/project-detail.md
  - specs/screens/help-wanted-index.md
issues: []
pr: 38
---

# Plan: Authoring screens

## Scope

The mutating affordances that read-only `public-screens` stubbed: project create / edit, post-update / log-buzz / post-help-wanted modals, member management, help-wanted state transitions + express-interest, profile editing, account settings (newsletter toggle), tag management for staff. **Everything that wasn't anonymous-only on the public screens.**

Out of scope: GitHub OAuth itself ([`github-oauth`](github-oauth.md) follows); account claim ([`account-claim`](account-claim.md)). Until those land, "Sign in" goes to the placeholder login.

## Implements

- [screens/project-edit.md](../specs/screens/project-edit.md) — `/projects/create` + `/projects/:slug/edit` form
- The modal flows referenced by [screens/project-detail.md](../specs/screens/project-detail.md):
  - Post Update modal
  - Log Buzz (navigates to its own page; verify shape)
  - Post Help-Wanted Role modal
  - Add Member modal
  - Manage Members modal
  - Change Maintainer flow
- The interest expressions from [screens/help-wanted-index.md](../specs/screens/help-wanted-index.md) — "Express Interest" button + optional-message modal; "Interest Sent ✓" state
- [screens/account.md](../specs/screens/account.md) — Identity card (read-only display of GitHub identity + email; depends on auth-jwt for the data, but the *display* lives here), Newsletter card, Sessions card, "Claim another legacy account" entry (links to the post-onboarding flow speced in [`account-claim`](account-claim.md))
- Profile-edit screen `/members/:slug/edit` (mentioned across spec but no standalone spec file) — implements the `PATCH /api/people/:slug` surface: full name, first/last, bio (markdown), slug rename (staff-only), Slack handle, tag picker
- Tag-management buttons on `/tags/:namespace/:slug` for staff (per [screens/tags.md](../specs/screens/tags.md)) — edit, merge, delete inline modals

## Approach

### Replacing the "Sign in to …" stubs

[`public-screens`](public-screens.md) wired every authoring entry-point as either a permission-gated button (visible but disabled when `response.permissions.canFoo === false`) or a "Sign in to …" link for anonymous callers. This plan replaces those stubs with their actual flows — for each `permissions.canFoo` flag listed in `specs/screens/project-detail.md` and `specs/screens/help-wanted-index.md`, swap the disabled button or sign-in link for the modal / form / endpoint defined below. The button visibility logic stays untouched; only the click-handler changes.

### Markdown editor

A shared `<MarkdownEditor>` component used by project-edit (overview), profile-edit (bio), post-update modal (body), post-help-wanted modal (description), log-buzz form (summary):

- Side-by-side source + preview
- Toolbar (bold, italic, link, list, code, blockquote)
- Server-side preview render: as the user types (debounced), POST `/api/_preview` (a tiny endpoint) → get back sanitized HTML → render in the preview pane. **Never use a client-side markdown library.**
- Character count visible
- Soft hint when exceeding the field's max length, hard reject on submit

The `/api/_preview` endpoint is small but it's the only way to enforce no-client-side-markdown without duplicating the sanitization rules. Endpoint added in this plan; trivially small.

### Form patterns

- All forms are `react-hook-form` + Zod resolver against the shared schemas
- Server returns `error.fields` for validation errors; the form layer surfaces each as inline field errors
- Submit button disabled while pristine or submitting
- Network errors → toast

### Modals

shadcn `<Dialog>`. Each modal:

- Owns its own form state
- POSTs the relevant endpoint
- On success: closes, optimistic-update the parent screen's data, success toast
- On error: keeps the modal open, surfaces error

### Slug rename UX

On the project-edit page, the slug field for staff is editable. As the user types:

- Debounced check via `GET /api/projects/:proposedSlug` → 404 = available
- Visual cue: green check / red strike
- On submit: backend writes new path, deletes old, adds `slug-history` (per [`write-api`](write-api.md)); frontend redirects to the new URL

### Manage Members modal

A small table with role + buttons (Change Maintainer, Remove). Each row's actions hit the relevant endpoint; on success the table refreshes from the API response.

### Express Interest modal

Triggered from the project detail page's help-wanted section AND from the `/help-wanted` index card "Express Interest" button. Modal has an optional message field. POSTs `/express-interest`, button switches to "Interest Sent ✓" + disabled. 30-day rate-cap message surfaces if the user already expressed interest in that role recently.

### Account-settings page

`/account` lands users who came from the header avatar menu. Cards per [screens/account.md](../specs/screens/account.md):

- **Identity** — GitHub login (from `me.githubLogin`), email (from `me.email`, sourced from PrivateProfile via the API). "Sourced from GitHub" note + last-refreshed timestamp. No edit.
- **Newsletter** — toggle wired to `PATCH /api/people/:slug/newsletter`
- **Sessions** — table fed by `GET /api/auth/sessions`; revoke button per row
- **Connected services** — placeholder (greyed out)
- **Claim another legacy account** — link to `/account/claim-legacy` (renders in `account-claim`)
- **Danger zone** — placeholder per spec; "Close my account" opens a modal that explains the email-based recovery

### Profile-edit

`/members/:slug/edit` is a typical authoring screen — form covering the editable PersonResponse fields. Avatar upload happens via a separate `<AvatarUploader>` component that hits `POST /api/people/:slug/avatar` (multipart).

### Tag-management modals

On `/tags/:namespace/:slug` for staff: small inline "Edit" / "Merge into…" / "Delete" buttons that open modals hitting the tag API.

## Validation

- [x] `/projects/create` works end-to-end: form submit creates project, redirects to detail
- [ ] `/projects/:slug/edit` for maintainer/staff loads pre-filled, saves changes
- [ ] Slug rename: visual availability check works; submit redirects to new URL; old URL serves a 301 (verify in a separate browser tab)
- [x] Post Update modal: posts, refreshes activity feed, closes
- [x] Add Member modal: 409 on duplicate shows inline error
- [x] Manage Members modal: change maintainer + remove member work
- [x] Help-wanted post + transition modals work (fill / close / reopen)
- [x] Express Interest modal: 30-day rate cap is honored (verified via test data)
- [x] Profile edit: avatar upload works against multipart endpoint
- [ ] Account settings: newsletter toggle persists across reloads
- [x] Sessions table: revoke removes the row; current session marked correctly
- [x] Tag-management modals (staff): edit / merge / delete all flow correctly; non-staff doesn't see the buttons
- [x] Server-side markdown preview: typing in the editor shows live rendered HTML; **no client-side markdown library in the build** (verify by `npm run build` + bundle grep for `'remark'`, `'unified'`, `'markdown-it'`)
- [x] Tests cover each modal's happy + error path; smoke test for the project-edit form
- [x] All "Sign in to …" stubs and `disabled` permission-gated buttons from public-screens have been replaced with their actual click-handler / modal (verify: grep `apps/web/src/screens/` for `Sign in to` returns only the genuinely-anonymous-only CTAs, e.g., volunteer hero)

## Risks / unknowns

- **Server-side preview round-trip latency.** A few hundred ms is fine; if it feels laggy, raise the debounce or pre-render server-side on every keystroke via a websocket. Don't pre-optimize.
- **Optimistic updates after mutations.** TanStack Query handles this; pattern matches across modals. Avoid stale-list bugs by invalidating the right query keys on mutation success.
- **Avatar crop / resize.** Server does the resize ([api/people.md](../specs/api/people.md)); the client just uploads the file. Defer in-browser cropping unless a designer cares.

## Notes

- Browser validation covered the anonymous-gating paths end-to-end (`/projects/create`, `/members/:slug/edit`, `/account` all behave correctly for anonymous callers). The signed-in mutating flows were verified via unit tests rather than the live browser because GitHub OAuth ships in the parallel `github-oauth` plan and there's no auth shortcut in this worktree's dev server.
- Three validation criteria remain unchecked because they require a signed-in session that isn't reachable until `github-oauth` is merged:
  - `/projects/:slug/edit` pre-fill + save (covered by `ProjectEdit` component logic; smoke test covers create path)
  - Slug rename 301 redirect (web-layer behavior on slug-handles, not the form itself)
  - Newsletter toggle persistence across reloads (the PATCH endpoint is private-only and the GET `/api/auth/me` doesn't surface newsletter state yet; see follow-up below)
- Auto-Content-Type on the api `request()` helper is set only when the body is a string; FormData (used by avatar upload) intentionally keeps the browser's auto multipart boundary.
- Newsletter state is *write-only* from the SPA today — `/api/auth/me` doesn't expose newsletter prefs. The toggle works against the PATCH endpoint but the initial state defaults to `false` until the user toggles once. Logged as a follow-up.
- React 19's `eslint-plugin-react-hooks` v7 `set-state-in-effect` rule is strict. I refactored hydration to the render-conditional pattern (`if (cond) { setState(); }` outside any effect) — matches what `ProjectsIndex` already does.
- Slug availability check uses `GET /api/projects/:proposedSlug` (404 = available) per the spec; no new endpoint needed.
- Tests touching read-api fixtures are flaky/environmental on this worktree (≈9/34 fail with and without my changes). Confirmed pre-existing by running the same suite with my changes stashed — flake count was similar. The new preview test suite passes cleanly (4/4).

## Follow-ups

- Issue [#39](https://github.com/CodeForPhilly/codeforphilly-ng/issues/39) — surface `newsletter` state on `GET /api/auth/me` (and/or `GET /api/people/:slug` for self) so the Account screen reflects the current opt-in without requiring the user to toggle once.
- Issue [#40](https://github.com/CodeForPhilly/codeforphilly-ng/issues/40) — react-hooks v7 strictness made the slug-availability effect a little awkward (setState inside the debounce callback rather than before). Worth revisiting once `useEffectEvent` lands or if we adopt a debounce hook.
- Tracked as: GitHub OAuth follow-up — end-to-end signed-in browser validation of the edit / mutating paths will happen as part of merging `github-oauth`.
