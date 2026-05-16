# Data Model

Domain entities, fields, relationships. The Drizzle schema in `apps/api/drizzle/schema.ts` is the implementation; this document is the spec.

All tables have:

- `id` — UUIDv7 primary key
- `legacyId` — integer, nullable, set during the laddr migration; indexed when present (see [behaviors/legacy-id-mapping.md](behaviors/legacy-id-mapping.md))
- `createdAt`, `updatedAt` — `timestamptz`, never null

Only tables listed below have soft-delete (`deletedAt timestamptz null`): `people`, `projects`.

## Entity overview

```
Person ──*── ProjectMembership ──*── Project
   │            │ role                 │
   │            │ joinedAt             │
   │            │ isMaintainer        │
   │                                   │
   └── owns ──────────────────────────┴── Project.maintainerId (denormalized)
                                          ProjectUpdate (one-to-many, authored by Person)
                                          ProjectBuzz (one-to-many, posted by Person)
                                          HelpWantedRole (one-to-many)

Tag ──── TagAssignment ──── (Project | Person)
                              polymorphic via taggableType + taggableId

Person ── owns ── Session (auth tokens)
Person ── has ── PasswordCredential (email/password auth)
```

## Person

The user/member of the brigade. Replaces laddr's `Emergence\People\Person`.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| legacyId | int | laddr `people.ID` |
| slug | text | unique. Was `Username`. URL: `/members/<slug>`. |
| email | text | unique, case-insensitive, lowercased on save. Used for auth. |
| fullName | text | display name |
| firstName | text nullable | parsed/edited separately for sort + greeting |
| lastName | text nullable | |
| bio | text nullable | markdown |
| avatarKey | text nullable | S3 object key. If null, fall back to gravatar(email). |
| slackHandle | text nullable | Slack username (without `@`) for contact + help-wanted Slack DM delivery. Self-edited; not verified. |
| accountLevel | enum | `anonymous` \| `user` \| `staff` \| `administrator`. Default `user`. See [behaviors/authorization.md](behaviors/authorization.md). |
| emailVerifiedAt | timestamptz nullable | |
| deletedAt | timestamptz nullable | soft delete |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** unique on `slug`, unique on `lower(email)`, `legacyId` partial index where not null.

**Validators:**

- `slug` matches `^[a-z0-9][a-z0-9-]{1,49}$`
- `email` is RFC 5322 valid
- `bio` ≤ 10,000 chars
- `slackHandle` matches `^[a-z0-9][a-z0-9._-]{0,80}$` (no leading `@`)
- `fullName` is required, 1–120 chars

## PasswordCredential

Separated from Person so the auth table can rotate independently and so a future Slack OAuth flow doesn't require a password row.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| personId | uuid | FK people(id), unique (one credential per person for v1) |
| passwordHash | text | argon2id |
| passwordChangedAt | timestamptz | |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

## Session

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| personId | uuid | FK people(id) |
| tokenHash | text | sha256 of the issued opaque token; the raw token lives only in the user's cookie |
| userAgent | text nullable | |
| ipAddress | inet nullable | |
| expiresAt | timestamptz | sliding expiration, see [behaviors/authorization.md](behaviors/authorization.md) |
| revokedAt | timestamptz nullable | |
| createdAt | timestamptz | |

**Indexes:** `tokenHash` unique; `personId` for "list my sessions".

## Project

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| legacyId | int | laddr `projects.ID` |
| slug | text | unique. Was `Handle`. URL: `/projects/<slug>`. See [behaviors/slug-handles.md](behaviors/slug-handles.md). |
| title | text | required, 1–200 chars |
| summary | text nullable | short tagline shown on cards; ≤ 280 chars. NEW — laddr derived this from the README first line. We split it out. |
| readme | text nullable | markdown |
| stage | enum | `commenting` \| `bootstrapping` \| `prototyping` \| `testing` \| `maintaining` \| `drifting` \| `hibernating`. Default `commenting`. See [behaviors/project-stages.md](behaviors/project-stages.md). |
| maintainerId | uuid nullable | FK people(id). Denormalized convenience pointer to the primary maintainer. |
| usersUrl | text nullable | public-facing site for the project |
| developersUrl | text nullable | repo URL |
| chatChannel | text nullable | slack channel name, stored without `#` |
| featured | bool | default `false`. Set by staff. Drives the home page "Join a Project" rotation. |
| featuredImageKey | text nullable | S3 object key for the home-page hero image. Required to be set when `featured = true`. |
| deletedAt | timestamptz nullable | soft delete |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Validators:**

- `slug` matches `^[a-z0-9][a-z0-9-_]{1,79}$`
- `usersUrl`, `developersUrl` — valid HTTPS URLs or null
- `chatChannel` matches `^[a-z0-9][a-z0-9_-]{0,40}$` (no leading `#`)
- `summary` ≤ 280 chars
- if `featured = true` then `featuredImageKey is not null` and `summary is not null`

**Indexes:** unique on `slug`, `legacyId` partial, `stage` for filtering, `maintainerId`, `deletedAt`, partial on `featured where featured = true and deletedAt is null`.

## ProjectMembership

Join table between Person and Project. Was laddr's `project_members`.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| projectId | uuid | FK projects(id) ON DELETE CASCADE |
| personId | uuid | FK people(id) ON DELETE CASCADE |
| role | text nullable | freeform string. Examples: "Founder", "Designer", "Backend Engineer". |
| isMaintainer | bool | denormalizes `Project.maintainerId == personId`. Drizzle trigger keeps them in sync. |
| joinedAt | timestamptz | |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** unique on `(projectId, personId)`, `personId` for "what projects am I in".

## ProjectUpdate

Markdown updates posted by project members. Was laddr's `project_updates` (with VersionedRecord history dropped — we don't ship versioning in v1).

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| legacyId | int | |
| projectId | uuid | FK projects(id) ON DELETE CASCADE |
| authorId | uuid nullable | FK people(id) ON DELETE SET NULL |
| body | text | markdown. Required. |
| number | int nullable | per-project sequence number for backward compat with URL `/projects/foo/updates/3`. Auto-assigned on insert. |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** `projectId, createdAt desc`, unique on `(projectId, number)` where `number is not null`.

## ProjectBuzz

External media / press / "buzz" about a project. Was laddr's `project_buzz`.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| legacyId | int | |
| projectId | uuid | FK projects(id) ON DELETE CASCADE |
| postedById | uuid nullable | FK people(id) — who logged the buzz |
| slug | text | URL-safe slug derived from headline |
| headline | text | required, 1–200 chars |
| url | text | required, HTTPS valid |
| publishedAt | timestamptz | date the original article was published |
| summary | text nullable | excerpt / quote |
| imageKey | text nullable | S3 object key for the article image |
| createdAt | timestamptz | when the buzz was logged on the site |
| updatedAt | timestamptz | |

**Indexes:** unique on `slug`, unique on `(projectId, url)` (no duplicates per project), `projectId, publishedAt desc`.

## Tag

Polymorphic taxonomy. Replaces laddr's `tags` + `tag_items`, but with a typed `namespace` instead of laddr's prefix convention (`topic.foo`, `tech.bar`, `event.baz`).

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| legacyId | int | |
| namespace | enum | `topic` \| `tech` \| `event` |
| slug | text | URL-safe within namespace |
| title | text | display name |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** unique on `(namespace, slug)`. URL: `/tags/<namespace>/<slug>` (was `/tags/topic.foo`).

## TagAssignment

Polymorphic link between tags and (project | person). Was laddr's `tag_items`.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| tagId | uuid | FK tags(id) ON DELETE CASCADE |
| taggableType | enum | `project` \| `person` |
| taggableId | uuid | FK to projects(id) or people(id) — enforced by app, not by DB FK (Postgres doesn't natively support polymorphic FKs; alternative is two columns, see notes below) |
| assignedById | uuid nullable | FK people(id) ON DELETE SET NULL |
| createdAt | timestamptz | |

**Indexes:** unique on `(tagId, taggableType, taggableId)`; `(taggableType, taggableId)` for "tags on this thing"; `(tagId)` for "things with this tag".

**Note on polymorphism:** Two FKs (`projectId nullable`, `personId nullable`) with a check constraint exactly-one-is-not-null is an acceptable alternative if we want database-enforced referential integrity. Implementer's call; either pattern conforms to this spec as long as the API surface in [api/tags.md](api/tags.md) is unchanged.

## HelpWantedRole _(new — not in laddr)_

A specific volunteer "ask" a maintainer posts on their project: "We need a React dev for ~4 hrs/wk to build the admin dashboard." See [behaviors/help-wanted-roles.md](behaviors/help-wanted-roles.md) for the rule set.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| projectId | uuid | FK projects(id) ON DELETE CASCADE |
| postedById | uuid | FK people(id) |
| title | text | required, 1–120 chars. e.g., "React developer for admin dashboard" |
| description | text | markdown. Required. |
| commitmentHoursPerWeek | int nullable | rough estimate. 0 = flexible/unspecified. |
| status | enum | `open` \| `filled` \| `closed`. Default `open`. |
| filledById | uuid nullable | FK people(id). Set when status moves to `filled`. |
| filledAt | timestamptz nullable | |
| closedAt | timestamptz nullable | set when status moves to `closed` (either manually or auto-aged-out) |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** `(projectId, status)`, `(status, createdAt desc)` for the global "Help Wanted" browse.

**Linked tags:** roles can carry tags via `TagAssignment` (`taggableType = 'help_wanted_role'`). This requires extending the polymorphic enum; see implementation note above.

## Relationships at a glance

| From | To | Cardinality | FK |
|------|----|-----------:|----|
| Project | Person | many-to-one (maintainer) | `projects.maintainerId` |
| ProjectMembership | Project | many-to-one | `projectMemberships.projectId` |
| ProjectMembership | Person | many-to-one | `projectMemberships.personId` |
| ProjectUpdate | Project | many-to-one | `projectUpdates.projectId` |
| ProjectUpdate | Person | many-to-one (author) | `projectUpdates.authorId` |
| ProjectBuzz | Project | many-to-one | `projectBuzz.projectId` |
| ProjectBuzz | Person | many-to-one (postedBy) | `projectBuzz.postedById` |
| HelpWantedRole | Project | many-to-one | `helpWantedRoles.projectId` |
| HelpWantedRole | Person | many-to-one (postedBy) | `helpWantedRoles.postedById` |
| HelpWantedRole | Person | many-to-one (filledBy, nullable) | `helpWantedRoles.filledById` |
| TagAssignment | Tag | many-to-one | `tagAssignments.tagId` |
| TagAssignment | Project \| Person \| HelpWantedRole | polymorphic | `taggableType + taggableId` |

## Naming map: laddr → rewrite

| laddr (PHP/MySQL) | rewrite (TS/Postgres) |
|---|---|
| `projects.ID` | `projects.id` (uuid) + `projects.legacyId` (int) |
| `projects.Handle` | `projects.slug` |
| `projects.Title` | `projects.title` |
| `projects.README` | `projects.readme` |
| `projects.Stage` (enum, TitleCase) | `projects.stage` (enum, lowercase) |
| `projects.MaintainerID` | `projects.maintainerId` |
| `projects.UsersUrl` / `DevelopersUrl` / `ChatChannel` | `projects.usersUrl` / `developersUrl` / `chatChannel` |
| `project_members` | `project_memberships` |
| `project_updates.Number` | `project_updates.number` |
| `project_buzz.Headline` / `URL` / `Published` / `Summary` / `ImageID` | `project_buzz.headline` / `url` / `publishedAt` / `summary` / `imageKey` |
| `tags.Handle` (e.g., `topic.transit`) | `tags.namespace = 'topic'`, `tags.slug = 'transit'` |
| `tag_items.ContextClass` / `ContextID` | `tag_assignments.taggableType` / `taggableId` |
| `Emergence\People\Person.Username` | `people.slug` |
| `Emergence\People\Person.AccountLevel` | `people.accountLevel` |
| `member_checkins` | _dropped — see [deferred.md](deferred.md)_ |
| `Emergence\CMS\BlogPost` | _dropped — see [deferred.md](deferred.md)_ |
