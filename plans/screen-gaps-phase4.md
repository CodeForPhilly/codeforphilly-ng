---
status: done
depends: [screen-gaps-phase3]
specs:
  - specs/api/projects-buzz.md
  - specs/screens/project-detail.md
issues: [83]
pr: 105
---

# Plan: screen-gaps phase 4 — `/projects/:slug/buzz/new` create form

## Scope

Last open piece of [#83](https://github.com/CodeForPhilly/codeforphilly-ng/issues/83). The route was a `<ComingSoon />` placeholder; the API endpoint (`POST /api/projects/:slug/buzz`) is fully implemented + tested. This plan ships the SPA form that closes the loop.

After this lands, `#83`'s engineering work is done — only the legacy-content port stays as a follow-up content PR.

## Implements

- [api/projects-buzz.md](../specs/api/projects-buzz.md) — request shape, validation, the `duplicate_url` 409.
- [screens/project-detail.md](../specs/screens/project-detail.md) — the "Log Buzz" affordance points here.

## Approach

### 1. Form component

`apps/web/src/screens/ProjectBuzzNew.tsx`:

- Route at `/projects/:slug/buzz/new` (replace `<ComingSoon />` in App.tsx).
- Fields per spec: headline (1-200 chars, required), url (HTTPS, required), publishedAt (date, required, defaults to today, max=today), summary (≤2000 chars markdown, optional).
- Submit calls existing `api.projects.postBuzz(slug, input)` helper.
- Success → `navigate(`/projects/${slug}#activity`)` so the new buzz appears in the project's activity feed.
- Failure surfaces inline field errors via `ApiError.fields`; the spec'd `duplicate_url` 409 maps to a field-level error on the URL input.
- Anonymous callers redirect to `/login?return=…` so the post-login flow drops them back on the form.

### 2. Tests

`apps/web/tests/ProjectBuzzNew.test.tsx`:

- Anonymous → login redirect carries return-to query
- Signed-in: form renders all required fields
- Submit disabled until headline + url filled
- Submit enabled once both are filled
- Successful submit navigates to project page

## Validation

- [x] `/projects/:slug/buzz/new` renders the form when signed in.
- [x] Anonymous callers redirect to `/login?return=`.
- [x] Successful POST navigates to `/projects/:slug`.
- [x] `duplicate_url` 409 surfaces inline on the URL field via the `ApiError.code` check — unit test covers the success path, the error-path mapping is one-line and matches `ProjectEdit`'s established pattern.
- [x] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Image upload deferred.** Spec's request shape allows an optional `imageUpload.key` from a prior upload endpoint. That upload surface doesn't exist for general media in v1 (per the spec note). Out of scope here — surfaces in the form would just be dead UI.
- **No anchor scroll on `#activity`.** The project-detail screen doesn't have an `#activity` element today. The navigate target stays as-is so the new buzz appears at the top of the activity feed (which is the default scroll position anyway). If a follow-up wants smooth scroll-to-anchor, the existing `anchor="update"` pattern works.

## Notes

Two commits: plan-open, impl + tests.

Surprises:

- **`useAuth` exposes `loading`, not `isLoading`.** Caught on first
  type-check — a small TanStack-Query convention mismatch with the
  project's own auth hook. Renamed at the destructure site.
- **The lingering `ComingSoon` import.** Removing the last
  `<ComingSoon />` usage at `/projects/:slug/buzz/new` left the
  import unused. ESLint caught it in the local sweep this time (lesson
  from PR #103's CI surprise). Bundled into this commit since it's
  the same logical change.
- **Submit-enabled gating.** Using a derived `disabled` (rather than
  separate validation state) keeps the affordance honest — the button
  literally can't be clicked until headline + url are non-empty. Native
  `required` + `type="url"` handles deeper validation at submit time.

## Follow-ups

- **#83 is now fully closed engineering-wise.** Four phased PRs:
  - phase 1 — ProjectDetail Share/stage-modal/Edit-on-GitHub + /contact (PR #102)
  - phase 2 — PersonDetail slackHandle + email (PR #103)
  - phase 3 — /pages/:slug bundled markdown (PR #104)
  - phase 4 — this PR (#105)
- **Legacy-content port** is the only remaining open thread under #83
  — port the real Mission/Leadership/CoC/Hackathons copy from
  `codeforphilly.org/site-root/pages/`. *Tracked as* — content task,
  no engineering blocker. Will file an issue when the content owner
  is identified.
- **Image upload for buzz** — spec allows an optional `imageUpload.key`
  attached to the POST. Needs a general-media upload endpoint that
  doesn't exist for v1 (per `specs/api/projects-buzz.md`). *None* —
  out of v1 scope.
