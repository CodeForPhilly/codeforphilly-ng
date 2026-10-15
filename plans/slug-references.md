---
status: in-progress
depends: [sheet-contracts]
specs:
  - specs/principles.md
  - specs/data-model.md
  - specs/behaviors/storage.md
  - specs/behaviors/slug-handles.md
---

# Plan: child records reference path-keyed parents by slug

## Scope

Apply [principles.md → A record holds everything its path
needs](../specs/principles.md#a-record-holds-everything-its-path-needs) to
the six sheets whose paths are keyed by a parent's handle:

| Sheet | Drops | Holds (required) |
| --- | --- | --- |
| project-memberships | `projectId`, `personId` | `projectSlug`, `personSlug` |
| project-updates | `projectId` | `projectSlug` |
| project-buzz | `projectId` | `projectSlug` |
| help-wanted-roles | `projectId` | `projectSlug` |
| help-wanted-interest | `personId` | `personSlug` (`roleId` stays: roles are keyed by id) |
| event-rsvps | `eventId`, `personId` | `year`, `eventSlug`, `personSlug` |

References outside paths (`authorId`, `postedById`, `filledById`, an RSVP's
`projectId`) stay ids.

In:

- **Schemas:** the six Zod schemas change, and each reference field
  declares its target (`projectSlug → projects.slug`). `@cfp/shared`
  derives a reference map from those declarations. The six contracts move
  to v2; the declaration metadata is stripped from the published
  documents, since gitsheets compiles contracts strictly.
- **API:** in-memory indexes and write services key these records by
  slug. The HTTP response shapes don't change: serializers resolve
  anything a client sees.
- **Renames:** every referencing record is rewritten on a project, person
  or event rename, using the reference map. The person cascade is new
  (memberships, interest, RSVPs and evaluations were left on the old slug
  before). Children's attachments (buzz images) move with them.
- **Data:** a one-shot migration rewrites existing records (slug fields
  from the on-disk values or id lookups, ids dropped) on `fixture`,
  `legacy-import` and, at release time, `published`, together with the v2
  contract adoption. The importer writes the new shape.

Out:

- Automatic, gitsheets-level cascades. Chris isn't committing to that;
  the reference map plus explicit service code covers it.
- The gitsheets 2.8 bump. It's its own plan
  ([`gitsheets-2.8`](gitsheets-2.8.md)) and lands after this, at which
  point #304's open-time check passes because every template field is
  required.

## Implements

- [principles.md](../specs/principles.md),
  [data-model.md](../specs/data-model.md),
  [behaviors/storage.md](../specs/behaviors/storage.md),
  [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md)

## Approach

1. Schemas, reference metadata and the derived map in `@cfp/shared`.
   Generate the v2 contracts, keeping v1 published unchanged.
2. API: state indexes, write services, serializers, the generic rename
   cascade, and prune-spam's person cascade.
3. Migration script (`apps/api/scripts/migrations/<ts>-slug-references.ts`):
   idempotent, verifies every reference resolves before writing, and
   commits once per branch.
4. Data repo: adopt the v2 contracts on `empty`, `fixture` and
   `legacy-import`, migrate their records, and mirror into
   `apps/api/gitsheets/` in the same PR. `published` follows at release
   time: adoption plus migration in one commit, then the deploys.
5. Tests: the generic rename test (rename a project, a person and an
   event, then assert no referencing record holds the old slug, iterating
   the reference map), plus migration round-trip and integrity tests.

## Validation

- [ ] The six schemas hold slug references; reference map derived; v2
      contracts published, v1 unchanged
- [ ] No `projectId`/`personId`/`eventId` left on the six sheets' records
      or in their indexes (grep), API responses unchanged (existing API
      tests green)
- [ ] Generic rename test covers every entry in the reference map
- [ ] Migration: idempotent; refuses to write if any reference doesn't
      resolve; `contracts verify` passes after it on every branch
- [ ] `type-check` + `lint` + full suite green
- [ ] `published` migrated and adopted in lockstep with the release;
      sandbox and production boot

## Risks / unknowns

- Breadth: about 650 id references across ~110 files, most in services and
  tests. The type checker carries most of it.
- Existing data quality: a child whose stored slug doesn't match its
  parent's current slug (e.g. a past person rename that never cascaded)
  is surfaced by the migration's resolve check, and fixed in the data
  rather than papered over.

## Notes

## Follow-ups
