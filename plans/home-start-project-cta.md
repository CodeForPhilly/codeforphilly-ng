---
status: done
depends: []
specs:
  - specs/screens/home.md
issues: []
pr: 128
---

# Plan: fix the home "Start a Project" CTA for logged-out visitors

## Scope

Leadership-team feedback (Kat + Travis, #0-leadership-team, June 2026, with
mobile screenshots) reported the home page's "Start a Project" card landing on
a dead page — `codeforphilly.gitbook.io/.../first-steps` now returns "Content
owner not found". The reported "works on laptop, not phone" symptom was really
**logged-in vs logged-out**, not responsive: the card branches on `person`, and
the anonymous branch pointed at the legacy GitBook URL.

What ships:

- **Spec fix first.** `specs/screens/home.md` prescribed the GitBook URL for the
  anonymous case — the spec was wrong, so it leads. Anonymous now routes through
  `/login?return=/projects/create`, matching the already-correct Volunteer
  screen convention (`volunteer.md:52`).
- **Code fix.** `Home.tsx` anonymous branch → `/login?return=/projects/create`;
  both branches are now in-app routes, so the `target="_blank"`/`rel` props drop
  away (no more external navigation through react-router `<Link>`).

## Implements

- [home.md](../specs/screens/home.md) — Get-involved card table + Authorization
  table: anonymous "Start a Project" routes through `/login?return=/projects/create`.

## Approach

### 1. Spec change (specops, source of truth first)

`specs/screens/home.md` — Get-involved card link cell and the Authorization
row both updated so the anonymous case is `/login?return=/projects/create`
instead of the external GitBook URL.

### 2. SPA: `apps/web/src/screens/Home.tsx`

`to={person ? '/projects/create' : '/login?return=/projects/create'}` and
remove the now-dead `target`/`rel` conditionals. Mirrors `Volunteer.tsx`.

## Validation

- [x] Spec updated: anonymous "Start a Project" → `/login?return=/projects/create`.
- [x] `Home.tsx` anonymous branch routes in-app; no external GitBook URL remains.
- [x] `target="_blank"`/`rel` props removed (both branches internal).
- [x] Browser test: logged-out home → "Start a Project" → `/login?return=/projects/create`
      renders the real sign-in page; GitHub link carries `return=%2Fprojects%2Fcreate`.
- [x] `npm run type-check && npm run lint && npm test` clean (web 74/74, shared 75/75).

## Risks

- Low. One-line behavior change on a well-trodden auth-redirect path already
  used by the Volunteer screen. `/login` honors `return` already.

## Notes

- The reported "works on laptop, not phone" was a misdiagnosis by the reporters:
  the card never branched on viewport, only on auth state (`person`). They were
  signed in on desktop, signed out on mobile. Worth remembering when triaging
  future "mobile-only" reports against this SPA — check auth state first.
- The footer's "Start a Project" link (`AppFooter.tsx`) always points at
  `/projects/create` unconditionally; for an anon user that hits the route's own
  auth guard rather than the friendly login redirect. Left as-is — out of scope,
  and the route guard handles it — but noted in case we want footer parity later.

## Follow-ups

Separately surfaced in the same Slack thread, **not** part of this plan's scope
(distinct features, not deferrals of this work):

- **Issue:** admin can edit but not delete users (project "Danger Zone" has
  delete; users don't) — parity gap reported by Travis.
- **Issue:** legacy image fallback — serve old-site images for users/projects
  (relates to the `codeforphilly-data-snapshot` work, #115).

These are unrelated to the CTA fix and should be filed/triaged on their own; the
CTA scope here is **None** outstanding.
