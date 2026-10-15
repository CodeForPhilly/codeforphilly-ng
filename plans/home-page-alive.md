---
status: done
depends: []
specs:
  - specs/screens/home.md
  - specs/screens/volunteer.md
  - specs/api/projects.md
  - specs/screens/chat.md
issues: []
---

# Plan: Make the home page look alive

## Scope

Chris's review of the live home page (2026-10-15): "Join a Project" was an
empty heading, the get-involved row led with "Sponsor", and on the
Volunteer page "When we meet" went to Meetup and every "Not a coder?" link
404'd.

**In:** `sort=activity` on `GET /api/projects`; "Join a Project" shows six
tiles, staff-featured first, then the most active projects; tiles without
an image drop the placeholder panel and show a stage badge; a "Join us on
Slack" card replaces "Sponsor"; Volunteer step 3 becomes "Come to a hack
night" → `/events`; the three "Not a coder?" links point at lists that
exist.

**Out:** Open Collective sponsors (next plan); curating featured projects
and images (data, not code).

## Implements

- [screens/home.md](../specs/screens/home.md) — Featured projects, Get involved.
- [screens/volunteer.md](../specs/screens/volunteer.md) — How it works,
  Not a coder.
- [api/projects.md](../specs/api/projects.md#get-apiprojects) — `activity` sort key.

## Approach

1. `ProjectService` computes each project's latest RSVP naming it, update,
   or buzz logged; projects with none sort last either way, then by
   `-updatedAt`.
2. Home fetches the featured list and `sort=-activity`, dedupes, takes six.

## Validation

- [x] `npm run type-check && npm run lint && npm test` clean.
- [x] Service test: activity order across RSVP, update and buzz; projects
  with none last in both directions; a newcomer RSVP counts for nothing.
- [x] Home on the dev server with the devbox data: six tiles led by the
  projects named in RSVPs, stage badges, no blank panels; Slack card first.
- [x] Volunteer: "Come to a hack night" → `/events`; pathway links resolve
  (`/projects?q=design` 42, `?q=research` 18, `topic.civicengagement` 14 on
  production).

## Risks / unknowns

- The activity sort reads `projectId` on updates, buzz and RSVPs, which the
  in-flight slug-references work renames; whichever lands second converts.

## Notes

- No project on production had `featured = true`, so the section rendered
  an empty heading; the activity fill means curation is now optional.
- The old pathway links targeted tags that never existed
  (`topic.design`, `topic.research`, `topic.civic-engagement`).

## Follow-ups

- **Deferred to plan:** Open Collective "Supported by" strip and sponsor
  links (`opencollective-sponsors`).
