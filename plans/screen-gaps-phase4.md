---
status: in-progress
depends: [screen-gaps-phase3]
specs:
  - specs/api/projects-buzz.md
  - specs/screens/project-detail.md
issues: [83]
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

- [ ] `/projects/:slug/buzz/new` renders the form when signed in.
- [ ] Anonymous callers redirect to `/login?return=`.
- [ ] Successful POST navigates to `/projects/:slug`.
- [ ] `duplicate_url` 409 surfaces inline on the URL field (manual smoke test — the unit test covers the success path).
- [ ] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Image upload deferred.** Spec's request shape allows an optional `imageUpload.key` from a prior upload endpoint. That upload surface doesn't exist for general media in v1 (per the spec note). Out of scope here — surfaces in the form would just be dead UI.
- **No anchor scroll on `#activity`.** The project-detail screen doesn't have an `#activity` element today. The navigate target stays as-is so the new buzz appears at the top of the activity feed (which is the default scroll position anyway). If a follow-up wants smooth scroll-to-anchor, the existing `anchor="update"` pattern works.

## Notes

_(filled at done time)_

## Follow-ups

_(filled at done time)_
