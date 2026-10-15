---
status: done
depends: [home-page-alive]
specs:
  - specs/screens/home.md
issues: []
---

# Plan: "Browse all N projects" on the home page

## Scope

Chris: "See all 274 projects →" under Join a Project should say "browse"
or "search". The link opens the searchable, filterable project list.

**In:** "Browse all N projects →", falling back to "Browse all projects →"
until the count loads (it rendered a double space before). **Out:** other
"See all" links (events, activity), which open plain lists.

## Implements

- [screens/home.md](../specs/screens/home.md) — Featured projects.

## Approach

One string in `Home.tsx`; a test on the link's text and target.

## Validation

- [x] `npm run type-check && npm run lint && npm test` clean.
- [x] Home test: "Browse all 42 projects →" links to `/projects`.

## Risks / unknowns

- None.

## Notes

- "Browse" over "Search": the page leads with the list and its filters;
  search is one of several ways in.

## Follow-ups

- **None.**
