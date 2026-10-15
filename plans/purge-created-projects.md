---
status: in-progress
depends: [slug-references]
specs:
  - specs/behaviors/person-lifecycle.md
  - specs/api/people.md
  - specs/api/projects.md
  - specs/data-model.md
issues: []
pr: 244
---

# Plan: Purge takes the projects only the purged person touched

## Scope

Chris purged a spam account on production (2026-10-15) and its three
projects stayed behind with no maintainer and no members; deleting one
through the UI only soft-deleted it. Purge should take those projects with
it, and projects should record who created them.

**In:** `createdById` on projects (set on create, never changed; projects
contract v2); purge hard-deletes each project the person created
(`createdById`, else `maintainerId` for projects without one) that nobody
else touched, with all its records (memberships, updates, buzz, help-wanted
roles and interest, tag-assignments, RSVPs naming it,
attachments); `GET /api/people/:slug/purge-preview`; the Danger Zone
confirm dialog lists the projects that will go.

**Out:** backfilling `createdById` on laddr projects from laddr's
`CreatorID`; clearing projects already orphaned by earlier purges (no
maintainer left to match).

## Implements

- [behaviors/person-lifecycle.md](../specs/behaviors/person-lifecycle.md#purge-cascading-hard-delete-admin-only)
- [api/people.md](../specs/api/people.md) — purge, purge-preview.
- [api/projects.md](../specs/api/projects.md#post-apiprojects) — `createdById` on create.
- [data-model.md](../specs/data-model.md#project) — `Project.createdById`.

## Approach

1. Schema + contract: `createdById` (uuid, nullable, optional) on
   `ProjectSchema`; bump `projects` to v2, regenerate `contracts/`, adopt
   on `empty`, `fixture` and `legacy-import`; `published` adopts at release
   with the slug-references migration.
2. `ProjectWriteService.create` sets `createdById` from the session.
3. A `purgeableProjects(person)` reader shared by preview and purge, then a
   project hard-delete inside the purge transaction, computed before the
   person's own records are removed.
4. Person page Danger Zone: fetch the preview when the dialog opens.

## Validation

- [x] `npm run type-check && npm run lint && npm test` clean.
- [x] Tests: a project created by the person with only their records is
  deleted with all its records; one with another member, another author's
  update, another's buzz, another's interest, or another's RSVP naming it
  survives; a legacy project matches by maintainer; preview lists exactly
  the purge's projects.
- [ ] Browser: the purge dialog lists the qualifying projects.

## Risks / unknowns

- Contract bump needs `published` adoption in lockstep with the release;
  coordinated with codeforphilly-ng-bd's pending v2 migration.

## Notes

## Follow-ups
