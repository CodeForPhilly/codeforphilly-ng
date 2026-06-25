---
status: in-progress
depends: []
specs:
  - specs/screens/home.md
issues: []
pr:
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

- [ ] Spec updated: anonymous "Start a Project" → `/login?return=/projects/create`.
- [ ] `Home.tsx` anonymous branch routes in-app; no external GitBook URL remains.
- [ ] `target="_blank"`/`rel` props removed (both branches internal).
- [ ] Browser test: logged-out home → click "Start a Project" → lands on
      `/login?return=/projects/create` (not the dead GitBook page).
- [ ] `npm run type-check && npm run lint && npm test` clean.

## Risks

- Low. One-line behavior change on a well-trodden auth-redirect path already
  used by the Volunteer screen. `/login` honors `return` already.

## Notes

## Follow-ups
