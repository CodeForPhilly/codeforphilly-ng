# Data Model

Domain entities, fields, relationships. Records live in **gitsheets** — see [behaviors/storage.md](behaviors/storage.md) for the storage architecture. The Zod schemas in `packages/shared/src/schemas/` are the implementation; this document is the spec.

Each entity is a sheet with a **path template** (where the TOML record lands on disk). Reverse lookups not supported by the path template are served by in-memory secondary indices built at boot.

All records have:

- `id` — UUIDv7
- `legacyId` — integer, optional, set during the laddr migration
- `createdAt`, `updatedAt` — ISO 8601 UTC strings, never absent

Only `people` and `projects` have soft-delete (`deletedAt`).

## Entity overview

```text
Person ──*── ProjectMembership ──*── Project
   │            │ role                 │
   │            │ joinedAt             │
   │            │ isMaintainer        │
   │                                   │
   └── owns ──────────────────────────┴── Project.maintainerId (denormalized)
                                          ProjectUpdate (one-to-many, authored by Person)
                                          ProjectBuzz (one-to-many, posted by Person)
                                          HelpWantedRole (one-to-many)
                                          HelpWantedInterestExpression (one-to-many)

Tag ──── TagAssignment ──── (Project | Person | HelpWantedRole)
                              polymorphic via taggableType + taggableId

Person ── has ── PasswordCredential       (1:1; removed in Phase 2 when GitHub OAuth ships)
       ── has ── Revocation               (0:many; revoked JWT IDs)
SlugHistory ── points at any renamed entity by (entityType, oldSlug)
StaffAction ── audit log
```

## Person

The user/member of the brigade. Replaces laddr's `Emergence\People\Person`.

**Sheet:** `people`
**Path template:** `people/${slug}.toml`

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| legacyId | int | laddr `people.ID` |
| slug | string | unique. Was `Username`. URL: `/members/<slug>`. |
| email | string | unique, case-insensitive, lowercased on save. Used for auth. |
| fullName | string | display name |
| firstName | string nullable | parsed/edited separately for sort + greeting |
| lastName | string nullable | |
| bio | string nullable | markdown |
| avatarKey | string nullable | gitsheets attachment key (e.g., `people/<slug>/avatar.jpg`). If absent, fall back to gravatar(email). |
| slackHandle | string nullable | Slack username (without `@`) for contact + help-wanted Slack DM delivery. Self-edited; not verified. |
| accountLevel | enum | `user` \| `staff` \| `administrator`. Default `user`. See [behaviors/authorization.md](behaviors/authorization.md). |
| emailVerifiedAt | iso8601 nullable | |
| deletedAt | iso8601 nullable | soft delete |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Validators:**

- `slug` matches `^[a-z0-9][a-z0-9-]{1,49}$`
- `email` is RFC 5322 valid
- `bio` ≤ 10,000 chars
- `slackHandle` matches `^[a-z0-9][a-z0-9._-]{0,80}$` (no leading `@`)
- `fullName` is required, 1–120 chars

**Secondary in-memory indices:**

- `bySlug.person: Map<slug, id>` — already implicit in the path template
- `byEmail: Map<lowerEmail, id>` — used by login + the laddr-migration matcher
- `byLegacyId.person: Map<legacyId, id>`

**Uniqueness:**

- `slug` (case-insensitive)
- `email` (case-insensitive)
- `legacyId` (when present)

The single-writer mutex makes these enforceable in-process: validate-then-write under the lock.

## PasswordCredential _(Phase 1 — removed in Phase 2)_

Separated from Person so the auth table can rotate independently. Will be deleted once GitHub OAuth ships in Phase 2 of the rewrite.

**Sheet:** `password-credentials`
**Path template:** `password-credentials/${personId}.toml`

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| personId | uuid | FK people.id, 1:1 |
| passwordHash | string | argon2id |
| passwordChangedAt | iso8601 | |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

## Revocation

Tracks revoked JWT IDs (`jti` claims) so that explicit sign-out / "revoke session" actions survive an API restart. See [behaviors/authorization.md](behaviors/authorization.md).

**Sheet:** `revocations`
**Path template:** `revocations/${jti}.toml`

| Field | Type | Notes |
|-------|------|-------|
| jti | string | the JWT ID being revoked. Also the filename. |
| personId | uuid | |
| revokedAt | iso8601 | |
| expiresAt | iso8601 | original expiry of the revoked token. After this, the record is safe to delete. |

A periodic background task (in-process) sweeps `revocations` for records whose `expiresAt < now` and deletes them.

**Secondary in-memory index:**

- `revokedJtis: Set<jti>` — checked on every authenticated request

## Project

**Sheet:** `projects`
**Path template:** `projects/${slug}.toml`

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| legacyId | int | laddr `projects.ID` |
| slug | string | unique. Was `Handle`. URL: `/projects/<slug>`. See [behaviors/slug-handles.md](behaviors/slug-handles.md). |
| title | string | required, 1–200 chars |
| summary | string nullable | short tagline shown on cards; ≤ 280 chars. NEW — laddr derived this from the README first line. We split it out. |
| readme | string nullable | markdown |
| stage | enum | `commenting` \| `bootstrapping` \| `prototyping` \| `testing` \| `maintaining` \| `drifting` \| `hibernating`. Default `commenting`. See [behaviors/project-stages.md](behaviors/project-stages.md). |
| maintainerId | uuid nullable | references people.id |
| usersUrl | string nullable | public-facing site for the project |
| developersUrl | string nullable | repo URL |
| chatChannel | string nullable | slack channel name, stored without `#` |
| featured | bool | default `false`. Set by staff. Drives the home page "Join a Project" rotation. |
| featuredImageKey | string nullable | gitsheets attachment key for the home-page hero image. Required when `featured = true`. |
| deletedAt | iso8601 nullable | soft delete |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Validators:**

- `slug` matches `^[a-z0-9][a-z0-9-_]{1,79}$`
- `usersUrl`, `developersUrl` — valid HTTPS URLs or absent
- `chatChannel` matches `^[a-z0-9][a-z0-9_-]{0,40}$` (no leading `#`)
- `summary` ≤ 280 chars
- if `featured = true` then `featuredImageKey is not absent` and `summary is not absent`

**Secondary in-memory indices:**

- `bySlug.project: Map<slug, id>`
- `byLegacyId.project: Map<legacyId, id>`
- `featuredProjectIds: Set<id>`
- `projectsByStage: Map<stage, Set<id>>` — for stage filter + facets

**Uniqueness:** `slug`, `legacyId` (when present).

## ProjectMembership

Join record between Person and Project. Was laddr's `project_members`.

**Sheet:** `project-memberships`
**Path template:** `project-memberships/${projectSlug}/${personSlug}.toml`

The composite path makes "list members of project X" a single directory traversal.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| projectId | uuid | references projects.id |
| personId | uuid | references people.id |
| role | string nullable | freeform. Examples: "Founder", "Designer", "Backend Engineer". |
| isMaintainer | bool | denormalizes `Project.maintainerId == personId`. Update both within the same gitsheets commit when changing the maintainer. |
| joinedAt | iso8601 | |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Secondary in-memory indices:**

- `membershipsByPerson: Map<personId, Set<membershipId>>` — for "my projects"
- `membershipsByProject: Map<projectId, Set<membershipId>>` — already implicit in path template

**Uniqueness:** `(projectId, personId)`.

## ProjectUpdate

Markdown updates posted by project members. Was laddr's `project_updates`. No version history in v1 (see [deferred.md](deferred.md)) — though "ProjectUpdate is a strong candidate for gitsheets propose-review flows later" is exactly the kind of upside the storage choice opens up.

**Sheet:** `project-updates`
**Path template:** `project-updates/${projectSlug}/${number}.toml`

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| legacyId | int | |
| projectId | uuid | |
| authorId | uuid nullable | references people.id; absent if the author was deleted |
| body | string | markdown. Required. |
| number | int | per-project sequence number, stable URL. Assigned on insert as `max(existing.number) + 1` within the project. Used as the filename. |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Secondary in-memory indices:**

- `updatesByProject: Map<projectId, sorted ProjectUpdate[]>` — implicit but cached for activity-feed reads
- `updatesByAuthor: Map<personId, Set<updateId>>` — for "recent updates by this person"

**Uniqueness:** `(projectId, number)`.

## ProjectBuzz

External media / press / "buzz" about a project. Was laddr's `project_buzz`.

**Sheet:** `project-buzz`
**Path template:** `project-buzz/${projectSlug}/${slug}.toml`

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| legacyId | int | |
| projectId | uuid | |
| postedById | uuid nullable | references people.id |
| slug | string | URL-safe slug derived from headline |
| headline | string | required, 1–200 chars |
| url | string | required, HTTPS valid |
| publishedAt | iso8601 | date the original article was published |
| summary | string nullable | excerpt / quote |
| imageKey | string nullable | gitsheets attachment key for the article image |
| createdAt | iso8601 | when the buzz was logged on the site |
| updatedAt | iso8601 | |

**Secondary in-memory indices:**

- `buzzByProject: Map<projectId, sorted ProjectBuzz[]>` — for the buzz feed
- `buzzByUrl: Map<projectId+url, id>` — for duplicate-URL detection

**Uniqueness:** `slug` (global), `(projectId, url)` (no duplicates per project).

## Tag

Polymorphic taxonomy. Replaces laddr's `tags` + `tag_items`, but with a typed `namespace` field instead of laddr's prefix convention (`topic.foo`, `tech.bar`, `event.baz`).

**Sheet:** `tags`
**Path template:** `tags/${namespace}/${slug}.toml`

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| legacyId | int | |
| namespace | enum | `topic` \| `tech` \| `event` |
| slug | string | URL-safe within namespace |
| title | string | display name |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Secondary in-memory indices:**

- `bySlug.tag: Map<namespace.slug, id>`
- `byLegacyId.tag: Map<legacyId, id>`

**Uniqueness:** `(namespace, slug)`.

URL: `/tags/<namespace>/<slug>` (was `/tags/topic.foo`).

## TagAssignment

Polymorphic link between tags and (project | person | help_wanted_role).

**Sheet:** `tag-assignments`
**Path template:** `tag-assignments/${tagId}/${taggableType}/${taggableId}.toml`

This composite path makes "things with tag X" a single directory traversal in the right shape; "tags on this thing" needs an in-memory inverted index.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| tagId | uuid | |
| taggableType | enum | `project` \| `person` \| `help_wanted_role` |
| taggableId | uuid | |
| assignedById | uuid nullable | references people.id |
| createdAt | iso8601 | |

**Secondary in-memory indices:**

- `tagsByAssignment: Map<type:id, Set<tagId>>` — the inverse lookup
- `assignmentsByTag: Map<tagId, Set<{ type, id }>>` — for global tag counts

**Uniqueness:** `(tagId, taggableType, taggableId)`.

## HelpWantedRole _(new — not in laddr)_

A specific volunteer "ask" a maintainer posts on their project. See [behaviors/help-wanted-roles.md](behaviors/help-wanted-roles.md) for the rule set.

**Sheet:** `help-wanted-roles`
**Path template:** `help-wanted-roles/${projectSlug}/${id}.toml`

The `id` is used as the filename (rather than a derived slug) because role titles are freeform and the URL form is `/projects/:slug/help-wanted/:roleId`.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| projectId | uuid | |
| postedById | uuid | references people.id |
| title | string | required, 1–120 chars |
| description | string | markdown. Required. |
| commitmentHoursPerWeek | int nullable | rough estimate. 0 = flexible/unspecified. |
| status | enum | `open` \| `filled` \| `closed`. Default `open`. |
| filledById | uuid nullable | references people.id. Set when status moves to `filled`. |
| filledAt | iso8601 nullable | |
| closedAt | iso8601 nullable | |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Secondary in-memory indices:**

- `helpWantedByProject: Map<projectId, Set<roleId>>` — implicit in path template
- `openHelpWanted: Set<roleId>` — for the `/help-wanted` global browse and the `?helpWanted=true` project filter

## HelpWantedInterestExpression

Tracks who has expressed interest in which role.

**Sheet:** `help-wanted-interest`
**Path template:** `help-wanted-interest/${roleId}/${personSlug}.toml`

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| roleId | uuid | references help-wanted-roles.id |
| personId | uuid | references people.id |
| message | string nullable | ≤ 2,000 chars plain text. Included verbatim in the notification email/DM. |
| createdAt | iso8601 | |

Used for the 30-day per-person-per-role rate cap on `POST /express-interest` (see [api/projects-help-wanted.md](api/projects-help-wanted.md)). The composite path makes the rate-cap check a path-exists test.

**Uniqueness:** `(roleId, personId)` _within the trailing 30 days_ — enforced by the API (read the existing record if any, check `createdAt`, accept-or-reject).

## SlugHistory

Records past slugs of an entity to power the 90-day redirect window. See [behaviors/slug-handles.md](behaviors/slug-handles.md).

**Sheet:** `slug-history`
**Path template:** `slug-history/${entityType}/${oldSlug}.toml`

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| entityType | enum | `project` \| `person` \| `tag` \| `buzz` |
| oldSlug | string | the previous slug, used as the filename |
| newSlug | string | the current canonical slug |
| entityId | uuid | the entity's id (so we can re-resolve even if the slug has moved again) |
| changedAt | iso8601 | |
| expiresAt | iso8601 | `changedAt + 90 days`. After this, the redirect is no longer served. |

A periodic in-process task deletes expired entries.

## StaffAction

Audit log for staff/administrator actions. See [behaviors/authorization.md](behaviors/authorization.md).

**Sheet:** `staff-actions`
**Path template:** `staff-actions/${year}/${month}/${id}.toml`

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| actorId | uuid | references people.id |
| action | string | e.g., `project.delete`, `account-level.change`, `tag.merge` |
| subjectType | enum | `project` \| `person` \| `tag` \| `help_wanted_role` \| `project_membership` |
| subjectId | uuid | |
| before | inline TOML table nullable | snapshot of the relevant record fields before the action |
| after | inline TOML table nullable | snapshot after |
| reason | string nullable | |
| createdAt | iso8601 | |

The time-partitioned path keeps any single directory bounded. The audit log is write-only; never edit or delete entries.

## Relationships at a glance

| From | To | Cardinality | Field |
|------|----|-----------:|----|
| Project | Person | many-to-one (maintainer) | `projects.maintainerId` |
| ProjectMembership | Project | many-to-one | `project_memberships.projectId` |
| ProjectMembership | Person | many-to-one | `project_memberships.personId` |
| ProjectUpdate | Project | many-to-one | `project_updates.projectId` |
| ProjectUpdate | Person | many-to-one (author) | `project_updates.authorId` |
| ProjectBuzz | Project | many-to-one | `project_buzz.projectId` |
| ProjectBuzz | Person | many-to-one (postedBy) | `project_buzz.postedById` |
| HelpWantedRole | Project | many-to-one | `help_wanted_roles.projectId` |
| HelpWantedRole | Person | many-to-one (postedBy / filledBy) | `help_wanted_roles.postedById`, `filledById` |
| HelpWantedInterestExpression | HelpWantedRole | many-to-one | `roleId` |
| HelpWantedInterestExpression | Person | many-to-one | `personId` |
| TagAssignment | Tag | many-to-one | `tagId` |
| TagAssignment | Project \| Person \| HelpWantedRole | polymorphic | `taggableType + taggableId` |

Cascading deletes are not enforced by gitsheets; the API's mutation services delete dependent records as part of the same write-and-commit operation (see [behaviors/storage.md](behaviors/storage.md) for atomicity). For project delete this means: in one mutation, write the project's tombstone (`deletedAt`) and (for cascade-on-hard-delete) the dependent project-memberships, project-updates, project-buzz, help-wanted-roles, and tag-assignments are removed.

## Naming map: laddr → rewrite

| laddr (PHP/MySQL) | rewrite (gitsheets/TOML) |
|---|---|
| `projects.ID` | `projects` record's `id` (uuid) + `legacyId` (int) |
| `projects.Handle` | `projects.slug` |
| `projects.Title` | `projects.title` |
| `projects.README` | `projects.readme` |
| `projects.Stage` (TitleCase) | `projects.stage` (lowercase) |
| `projects.MaintainerID` | `projects.maintainerId` |
| `projects.UsersUrl` / `DevelopersUrl` / `ChatChannel` | `projects.usersUrl` / `developersUrl` / `chatChannel` |
| `project_members` | `project-memberships` sheet |
| `project_updates.Number` | `project_updates.number` |
| `project_buzz.Headline` / `URL` / `Published` / `Summary` / `ImageID` | `project_buzz.headline` / `url` / `publishedAt` / `summary` / `imageKey` |
| `tags.Handle` (e.g., `topic.transit`) | `tags.namespace = 'topic'`, `tags.slug = 'transit'` |
| `tag_items.ContextClass` / `ContextID` | `tag-assignments.taggableType` / `taggableId` |
| `Emergence\People\Person.Username` | `people.slug` |
| `Emergence\People\Person.AccountLevel` | `people.accountLevel` |
| `Emergence\People\Person.AccountLevel` value `User` | `accountLevel = 'user'` (anonymous is _no record_, not a stored level) |
| Database tables | gitsheets sheets |
| `INDEX`, `UNIQUE INDEX` | enforced in-process by the API under the write mutex; backed by in-memory indices built at boot |
| `FOREIGN KEY ... ON DELETE CASCADE` | atomic multi-record gitsheets commit (see Storage spec) |
| `member_checkins` | _dropped — see [deferred.md](deferred.md)_ |
| `Emergence\CMS\BlogPost` | _dropped — see [deferred.md](deferred.md)_ |
