# Data Model

Domain entities, fields, relationships. Records live in **gitsheets** — see [behaviors/storage.md](behaviors/storage.md) for the storage architecture. The Zod schemas in `packages/shared/src/schemas/` are the implementation; this document is the spec.

Each entity is a sheet with a **path template** (where the TOML record lands on disk). Reverse lookups not supported by the path template are served by in-memory secondary indices built at boot.

All records have:

- `id` — UUIDv7
- `legacyId` — integer, optional, set during the laddr migration
- `createdAt`, `updatedAt` — ISO 8601 UTC strings, never absent

Only `people` and `projects` have soft-delete (`deletedAt`).

**References.** A record whose path is keyed by a parent's handle references that parent by the handle (`projectSlug`, `personSlug`, `eventSlug`), never by the parent's id ([principles.md → A record holds everything its path needs](principles.md#a-record-holds-everything-its-path-needs)). Every such field is required, and the schema declares what it references (e.g. `projectSlug → projects.slug`) so a rename can find every record to rewrite. References that are not part of a path stay ids.

## Entity overview

```text
PUBLIC (gitsheets) ─────────────────────────────────────────────────────

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

BlogPost ──── authored-by ──── Person      (0:1; staff-authored long-form posts)

EventSeries ──*── Event ──*── EventRsvp ──*── Person   (staff-created gatherings; member RSVPs)
  (optional:           │ agenda[]          │ plan + projectId (optional)
   "Monthly Hack       │ (structured       └── Project   ("working on" at the event)
    Nights")           │  schedule)

Tag ──── TagAssignment ──── (Project | Person | HelpWantedRole | BlogPost)
                              polymorphic via taggableType + taggableId

Person ── has ── Revocation               (0:many; revoked JWT IDs)
SlugHistory ── points at any renamed entity by (entityType, oldSlug)

PRIVATE (S3-compatible bucket) ─────────────────────────────────────────

Person.id ──── PrivateProfile             (1:1; email, newsletter prefs)
          └── LegacyPasswordCredential   (0:1; from laddr import, drains to zero)

The audit log for public data is the commit log itself — see
[behaviors/storage.md](behaviors/storage.md#commits-are-the-audit-log).
Private mutations are tracked via bucket versioning — see
[behaviors/private-storage.md](behaviors/private-storage.md).
```

## Person _(public)_

The user/member of the brigade. Replaces laddr's `Emergence\People\Person`. Stored in the **public** gitsheets repo — anyone cloning the data repo can see these fields. Email, password hashes, and other sensitive fields live in the private store (see [PrivateProfile](#privateprofile-private) below).

**Sheet:** `people`
**Path template:** `people/${slug}.toml`

| Field | Type | Notes |
| ------- | ------ | ------- |
| id | uuid | |
| legacyId | int | laddr `people.ID` |
| slug | string | unique. Was `Username`. URL: `/members/<slug>`. |
| fullName | string | display name |
| firstName | string nullable | parsed/edited separately for sort + greeting |
| lastName | string nullable | |
| bio | string nullable | markdown |
| avatarKey | string nullable | gitsheets attachment key (e.g., `people/<slug>/avatar.jpg`). If absent, fall back to a generic-avatar placeholder (no email-based gravatar — emails aren't in the public record). |
| slackHandle | string nullable | Slack username (without `@`) for contact + help-wanted Slack DM delivery. Self-edited; not verified. |
| accountLevel | enum | `user` \| `staff` \| `administrator`. Default `user`. See [behaviors/authorization.md](behaviors/authorization.md). |
| githubUserId | int nullable | GitHub's numeric user ID (stable across renames). Set when the Person links a GitHub identity — see [behaviors/account-migration.md](behaviors/account-migration.md). |
| githubLogin | string nullable | GitHub username (mutable on GitHub's side; updated on every login). |
| githubLinkedAt | iso8601 nullable | When GitHub identity was first attached. |
| slackSamlNameId | string nullable | Immutable per-person identifier used as SAML `NameID.Value` for Slack SSO (see [api/saml.md](api/saml.md)). Populated from `slug` at Person creation; never changes after, even if the slug is renamed. |
| deletedAt | iso8601 nullable | soft delete |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Public-record cleanliness rule:** no field in this sheet may carry email addresses, password material, IP addresses, or other PII. The public gitsheets repo is pushed to a publicly cloneable remote.

**Validators:**

- `slug` matches `^[a-z0-9][a-z0-9-]{1,49}$`
- `bio` ≤ 10,000 chars
- `slackHandle` matches `^[a-z0-9][a-z0-9._-]{0,80}$` (no leading `@`)
- `fullName` is required, 1–120 chars
- `githubUserId` ≥ 1 when present
- `githubLogin` matches GitHub's username regex `^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$` when present
- `slackSamlNameId` matches `^[a-z0-9][a-z0-9-]{1,49}$` (slug shape); immutable after first set

**Secondary in-memory indices:**

- `bySlug.person: Map<slug, id>` — already implicit in the path template
- `byLegacyId.person: Map<legacyId, id>`
- `byGithubUserId: Map<githubUserId, id>` — used by GitHub OAuth callback for "is this GitHub user already linked?"
- `bySlackSamlNameId: Map<slackSamlNameId, id>` — used by SAML IdP

**Uniqueness:**

- `slug` (case-insensitive)
- `legacyId` (when present)
- `githubUserId` (when present)
- `slackSamlNameId` (when present)

The single-writer mutex makes these enforceable in-process: validate-then-write under the lock.

## PrivateProfile _(private)_

The sensitive complement to a Person. Stored in the **private store** (S3-compatible bucket), keyed by `personId`. See [behaviors/private-storage.md](behaviors/private-storage.md).

**Storage:** `profiles.jsonl` in the private bucket — one record per line, single overwrite per mutation.

| Field | Type | Notes |
| ------- | ------ | ------- |
| personId | uuid | references `Person.id` |
| email | string | the user's most-recent GitHub-verified primary email. Refreshed on every OAuth login. Lowercased for canonical form. |
| emailRefreshedAt | iso8601 | when `email` was last refreshed from GitHub |
| newsletter | object nullable | newsletter subscription state (see below) |
| updatedAt | iso8601 | |

The `newsletter` sub-object:

| Field | Type | Notes |
| ------- | ------ | ------- |
| optedIn | bool | |
| optedInAt | iso8601 nullable | |
| optedOutAt | iso8601 nullable | |
| unsubscribeToken | string nullable | 32 bytes CSPRNG base64url; used for one-click unsubscribe links in newsletter emails |

**Validators:**

- `email` is RFC 5322 valid, lowercased
- `unsubscribeToken` matches `^[A-Za-z0-9_-]{43}$` (base64url of 32 bytes)

**Secondary in-memory indices:**

- `byEmail: Map<lowerEmail, personId>` — for laddr-migration claim flow and "find candidate when GitHub gives us a verified email"
- `byUnsubscribeToken: Map<token, personId>` — for newsletter unsubscribe handler

**Uniqueness:**

- `personId` (one profile per Person)
- `email` (case-insensitive) — enforced; if a GitHub OAuth login surfaces an email that matches an _unlinked_ legacy Person, the account-claim flow kicks in instead of letting the email collide.
- `unsubscribeToken`

## Newsletter sends _(deferred from v1)_

Sending newsletters is out of scope for v1 (see [deferred.md](deferred.md)). v1 only persists subscription state in `PrivateProfile.newsletter` so staff can CSV-export to whatever sending tool they currently use.

## LegacyPasswordCredential _(private)_

Carries a laddr user's old password hash forward through the migration so they can keep signing in via password indefinitely after cutover — see [behaviors/account-migration.md](behaviors/account-migration.md). The credential stays in place across sessions and is **rehashed in place** on every successful login per [behaviors/password-hash-rotation.md](behaviors/password-hash-rotation.md), so the corpus drifts from laddr's unsalted SHA-1 to argon2id without forcing resets.

The rewrite **creates** new records only via `POST /api/auth/password-reset/confirm` (writing argon2id-hashed plaintext) — never from a sign-up flow.

Password material is sensitive and **must not** appear in the public gitsheets repo — it lives in the private store. See [behaviors/private-storage.md](behaviors/private-storage.md).

**Storage:** `legacy-passwords.jsonl` in the private bucket — one record per line, single overwrite per mutation.

| Field | Type | Notes |
| ------- | ------ | ------- |
| personId | uuid | references `Person.id`, 1:1 |
| passwordHash | string | The current password hash. Format is auto-detected by the verifier (SHA-1 hex / bcrypt `$2[aby]$` / argon2id `$argon2id$`). Every successful verify rotates this to argon2id with current params. |
| importedAt | iso8601 | when the laddr migration wrote this record |
| lastUsedAt | iso8601 nullable | timestamp of the last successful password sign-in (or password reset). `null` for records that haven't been used since import. Supports the future sunset-coverage report in [behaviors/account-migration.md](behaviors/account-migration.md#coverage-metric-for-future-sunset-planning). |

No `id`, `createdAt`, `updatedAt` — `personId` is the natural key; `importedAt` records creation, `lastUsedAt` records last successful use.

**Secondary in-memory index:**

- `legacyPasswordByPersonId: Map<personId, LegacyPasswordCredential>` — only used by the account-claim endpoint

## Revocation

Tracks revoked JWT IDs (`jti` claims) so that explicit sign-out / "revoke session" actions survive an API restart. See [behaviors/authorization.md](behaviors/authorization.md).

**Sheet:** `revocations`
**Path template:** `revocations/${jti}.toml`

| Field | Type | Notes |
| ------- | ------ | ------- |
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
| ------- | ------ | ------- |
| id | uuid | |
| legacyId | int | laddr `projects.ID` |
| slug | string | unique. Was `Handle`. URL: `/projects/<slug>`. See [behaviors/slug-handles.md](behaviors/slug-handles.md). |
| title | string | required, 1–200 chars |
| summary | string nullable | short tagline shown on cards; ≤ 280 chars. NEW — laddr derived this from the README first line. We split it out. |
| overview | string nullable | long-form project description in markdown. Renamed from laddr's `README` because it is _not_ the same thing as the project's GitHub README — see [deferred.md](deferred.md#cached-github-readme-on-project-pages) for the planned cached-github-readme alongside. |
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
| ------- | ------ | ------- |
| id | uuid | |
| projectSlug | string | references `projects.slug`; path field |
| personSlug | string | references `people.slug`; path field |
| role | string nullable | freeform. Examples: "Founder", "Designer", "Backend Engineer". |
| isMaintainer | bool | denormalizes `Project.maintainerId` resolving to this member. Update both within the same gitsheets commit when changing the maintainer. |
| joinedAt | iso8601 | |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Secondary in-memory indices:**

- `membershipsByPerson: Map<personSlug, Set<membershipId>>` — for "my projects"
- `membershipsByProject: Map<projectSlug, Set<membershipId>>` — already implicit in path template

**Uniqueness:** `(projectSlug, personSlug)`.

## ProjectUpdate

Markdown updates posted by project members. Was laddr's `project_updates`. No version history in v1 (see [deferred.md](deferred.md)) — though "ProjectUpdate is a strong candidate for gitsheets propose-review flows later" is exactly the kind of upside the storage choice opens up.

**Sheet:** `project-updates`
**Path template:** `project-updates/${projectSlug}/${number}.toml`

| Field | Type | Notes |
| ------- | ------ | ------- |
| id | uuid | |
| legacyId | int | |
| projectSlug | string | references `projects.slug`; path field |
| authorId | uuid nullable | references people.id; absent if the author was deleted |
| body | string | markdown. Required. |
| number | int | per-project sequence number, stable URL. Assigned on insert as `max(existing.number) + 1` within the project. Used as the filename. |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Secondary in-memory indices:**

- `updatesByProject: Map<projectSlug, sorted ProjectUpdate[]>` — implicit but cached for activity-feed reads
- `updatesByAuthor: Map<personId, Set<updateId>>` — for "recent updates by this person"

**Uniqueness:** `(projectSlug, number)`.

## BlogPost

Staff-authored long-form posts at `/blog`. Was laddr's `blog_posts`. Stored as a **content-typed** gitsheets sheet: on-disk artifacts are Hugo-style markdown (`+++` TOML frontmatter + body), one `.md` file per slug. Writes happen via PR to the data repo (not a runtime CMS). See [api/blog.md](api/blog.md), [screens/blog-index.md](screens/blog-index.md), [screens/blog-detail.md](screens/blog-detail.md).

**Sheet:** `blog-posts`
**Path template:** `blog-posts/${slug}.md`
**Format:** `markdown` (gitsheets `[gitsheet.format]` with `type = 'markdown'`, `body = 'body'`)

| Field | Type | Notes |
| ------- | ------ | ------- |
| id | uuid | |
| legacyId | int nullable | laddr `blog_posts.ID`. Per [behaviors/legacy-id-mapping.md](behaviors/legacy-id-mapping.md). |
| slug | string | unique. URL: `/blog/<slug>`. Used as the filename (`<slug>.md`). |
| title | string | display title; 1-200 chars. |
| summary | string nullable | short markdown blurb (≤500 chars) for the index card. |
| authorId | uuid nullable | references `people.id`; null if the author was deleted or never set. |
| postedAt | iso8601 | publish timestamp; primary sort key for the index. |
| editedAt | iso8601 nullable | last meaningful edit; surfaces as "Edited <relative>" on the detail screen when it differs from `postedAt`. |
| featuredImageKey | string nullable | gitsheets attachment key (e.g., `blog-posts/<slug>/cover.jpg`). Served via `GET /api/attachments/:key`. |
| deletedAt | iso8601 nullable | soft-delete; excluded from API responses. |
| body | string | markdown body — the **content** of the file, separated from frontmatter by `+++` per the gitsheets content-typed convention. |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Secondary in-memory indices:**

- `blogPostIdBySlug: Map<slug, id>` — slug → id for route resolution
- `blogPostIdByLegacyId: Map<int, id>` — for importer idempotence and (future) legacy URL redirects

**Uniqueness:** `slug` (global). `legacyId` is unique-where-present.

**Lazy body loading is deferred to [#45](https://github.com/CodeForPhilly/codeforphilly-ng/issues/45)** — initial implementation loads full bodies on every list query. Acceptable at current scale (<100 posts).

## ProjectBuzz

External media / press / "buzz" about a project. Was laddr's `project_buzz`.

**Sheet:** `project-buzz`
**Path template:** `project-buzz/${projectSlug}/${slug}.toml`

| Field | Type | Notes |
| ------- | ------ | ------- |
| id | uuid | |
| legacyId | int | |
| projectSlug | string | references `projects.slug`; path field |
| postedById | uuid nullable | references people.id |
| slug | string | URL-safe slug derived from headline |
| headline | string | required, 1–200 chars |
| url | string | required, valid URL (any scheme). Historical laddr buzz includes mid-2010s `http://` press links still served as plain HTTP today — preserved for fidelity. |
| publishedAt | iso8601 | date the original article was published |
| summary | string nullable | excerpt / quote |
| imageKey | string nullable | gitsheets attachment key for the article image |
| createdAt | iso8601 | when the buzz was logged on the site |
| updatedAt | iso8601 | |

**Secondary in-memory indices:**

- `buzzByProject: Map<projectSlug, sorted ProjectBuzz[]>` — for the buzz feed
- `buzzByUrl: Map<projectSlug+url, id>` — for duplicate-URL detection

**Uniqueness:** `slug` (global), `(projectSlug, url)` (no duplicates per project).

## Tag

Polymorphic taxonomy. Replaces laddr's `tags` + `tag_items`, but with a typed `namespace` field instead of laddr's prefix convention (`topic.foo`, `tech.bar`, `event.baz`).

**Sheet:** `tags`
**Path template:** `tags/${namespace}/${slug}.toml`

| Field | Type | Notes |
| ------- | ------ | ------- |
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

**Legacy-import policy:** laddr tags whose `Handle` is a bare word (no `topic.`/`tech.`/`event.` prefix) and whose `Title` also lacks a prefix default to `namespace: 'topic'`. These are mostly low-traffic org/event keywords created via laddr's autocomplete-create flow without typing a namespace. The importer emits an audit warning per defaulted tag so operators can re-namespace them later via tooling. See [issue #58](https://github.com/CodeForPhilly/codeforphilly-ng/issues/58).

## TagAssignment

Polymorphic link between tags and (project | person | help_wanted_role).

**Sheet:** `tag-assignments`
**Path template:** `tag-assignments/${tagId}/${taggableType}/${taggableId}.toml`

This composite path makes "things with tag X" a single directory traversal in the right shape; "tags on this thing" needs an in-memory inverted index.

| Field | Type | Notes |
| ------- | ------ | ------- |
| id | uuid | |
| tagId | uuid | |
| taggableType | enum | `project` \| `person` \| `help_wanted_role` \| `blog_post` |
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
| ------- | ------ | ------- |
| id | uuid | |
| projectSlug | string | references `projects.slug`; path field |
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

- `helpWantedByProject: Map<projectSlug, Set<roleId>>` — implicit in path template
- `openHelpWanted: Set<roleId>` — for the `/help-wanted` global browse and the `?helpWanted=true` project filter

## HelpWantedInterestExpression

Tracks who has expressed interest in which role.

**Sheet:** `help-wanted-interest`
**Path template:** `help-wanted-interest/${roleId}/${personSlug}.toml`

| Field | Type | Notes |
| ------- | ------ | ------- |
| id | uuid | |
| roleId | uuid | references help-wanted-roles.id; path field (roles are keyed by id) |
| personSlug | string | references `people.slug`; path field |
| message | string nullable | ≤ 2,000 chars plain text. Included verbatim in the notification email/DM. |
| createdAt | iso8601 | |

Used for the 30-day per-person-per-role rate cap on `POST /express-interest` (see [api/projects-help-wanted.md](api/projects-help-wanted.md)). The composite path makes the rate-cap check a path-exists test.

**Uniqueness:** `(roleId, personSlug)` _within the trailing 30 days_ — enforced by the API (read the existing record if any, check `createdAt`, accept-or-reject).

## Event _(new — replaces Meetup.com)_

A single gathering at one venue over one contiguous span: a hack night, a workshop, one day of a hackathon. Staff-authored; members RSVP. Rules in [behaviors/events.md](behaviors/events.md). Events are **flat** — one record is one thing you can RSVP to. Two optional structures hang off it: a link to an [EventSeries](#eventseries-new) ("Launchpad 2018", "Monthly Hack Nights") and an embedded **agenda** of time slots within the event. A program that moves between venues or spans days is a series of events, not one event.

**Sheet:** `events`
**Path template:** `events/${year}/${slug}.md` where `year` is rendered from `startsAt` by gitsheets' native date bucketing (`${{ startsAt: YYYY }}` — the UTC year)
**Format:** `markdown` — the `description` field is the file body, after `+++` TOML frontmatter, like blog posts

The sheet is partitioned by year because monthly events accrete forever; within a year the default slug is date-first (`2026-11-03-hack-night`) so the directory lists chronologically when browsed in the data repo. The slug stays globally unique — the year is a storage partition, not part of the URL.

| Field | Type | Notes |
| ------- | ------ | ------- |
| id | uuid | Also the stable iCalendar `UID` (`<id>@codeforphilly.org`). |
| legacyId | int nullable | Unused today. A laddr "event" was a whole program and backfills as a series matched by slug, with its days as events matched by `(seriesId, day)` ([behaviors/events.md](behaviors/events.md#legacy-urls)); no laddr row maps onto a single event. Reserved for a future import that does. |
| slug | string | unique. URL: `/events/<slug>`. See [behaviors/slug-handles.md](behaviors/slug-handles.md). |
| title | string | required, 1–200 chars |
| description | string nullable | markdown, ≤ 20,000 chars — the file body |
| startsAt | iso8601 | required |
| endsAt | iso8601 | required; strictly after `startsAt` |
| venueName | string nullable | ≤ 120 chars |
| venueAddress | string nullable | ≤ 300 chars; rendered as a Google Maps link |
| onlineUrl | string nullable | HTTPS; video-call or stream link |
| meetupUrl | string nullable | HTTPS on `meetup.com`; secondary link during the Meetup transition |
| seriesId | uuid nullable | references event-series.id — "part of Monthly Hack Nights" |
| agenda | array of tables | ordered timed items rendered as the Schedule sidebar; see [Agenda items](#agenda-items) below. Empty for a plain hack night. |
| status | enum | `draft` \| `scheduled` \| `cancelled`. Default `scheduled`. Transitions via dedicated endpoints only. |
| cancelledAt | iso8601 nullable | set by `cancel` |
| cancellationNote | string nullable | ≤ 500 chars plain text; set by `cancel` |
| icsSequence | int | default `0`. Incremented on every calendar-relevant change and on cancel — becomes iCalendar `SEQUENCE`. |
| reminders | table | `{ weekSentAt?: iso8601, daySentAt?: iso8601 }` — at-most-once bookkeeping for the reminder sweep ([behaviors/events.md#reminders](behaviors/events.md#reminders)). |
| createdById | uuid nullable | references people.id (staff) |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

Times are UTC on disk like every timestamp; display is always `America/New_York`.

### Agenda items

Each entry of `agenda` (TOML `[[agenda]]`) is a timed line in the event's schedule — laddr's `EventSegment`, embedded rather than a separate record. Items have no RSVPs, no slug, and no page of their own.

| Field | Type | Notes |
| ------- | ------ | ------- |
| startsAt | iso8601 | within `[event.startsAt, event.endsAt]` |
| endsAt | iso8601 nullable | after `startsAt` when present |
| title | string | required, 1–120 chars |
| venueName | string nullable | ≤ 120; overrides the event venue for this item |
| venueAddress | string nullable | ≤ 300 |
| description | string nullable | markdown, ≤ 2,000 chars |

Items are kept sorted by `startsAt` on write; a cap of 50 items per event keeps the record readable.

**Validators:**

- `slug` matches `^[a-z0-9][a-z0-9-_]{1,99}$`; not a reserved slug (`past`, `upcoming`, `series`, `feed`, `new`, …)
- `endsAt > startsAt`
- `onlineUrl`, `meetupUrl` are HTTPS URLs when present; `meetupUrl` host ends in `meetup.com`
- `cancelledAt` present iff `status = cancelled`
- every `agenda[].startsAt` within the event's range; `agenda.length ≤ 50`

**Secondary in-memory indices:**

- `eventIdBySlug: Map<slug, id>`
- `eventIdByLegacyId: Map<int, id>` — importer idempotence only
- `eventsByStartsAt: sorted Event[]` — upcoming/past slicing and the reminder sweep
- `eventsBySeries: Map<seriesId, Set<eventId>>` — the series page

**Uniqueness:** `slug` (case-insensitive). `legacyId` unique-where-present.

## EventSeries _(new)_

A named grouping of events. Two shapes share the record: a **program instance** — "Launchpad 2018" is a series whose three days are its events, each with its own venue and agenda — and an **open-ended set** — "Monthly Hack Nights" accretes one event a month. A series carries no dates of its own (its events do) and takes no RSVPs. It exists so the detail page can say "Part of Launchpad 2018", so a series page can list every event past and future, and so duplicating an event carries the grouping forward. "Launchpad" alone is not a series; each year's program is.

**Sheet:** `event-series`
**Path template:** `event-series/${slug}.md`
**Format:** `markdown` — the `description` field is the file body

| Field | Type | Notes |
| ------- | ------ | ------- |
| id | uuid | |
| slug | string | unique. URL: `/events/series/<slug>`. |
| title | string | required, 1–120 chars |
| description | string nullable | markdown, ≤ 10,000 chars — the file body |
| createdAt | iso8601 | |
| updatedAt | iso8601 | |

**Validators:** `slug` matches `^[a-z0-9][a-z0-9-]{1,99}$` and is not reserved.

**Secondary in-memory indices:** `eventSeriesIdBySlug: Map<slug, id>`.

**Uniqueness:** `slug` (case-insensitive). Deleting a series is allowed only when no event references it (`409 has_events`).

## EventRsvp _(new)_

A member's public "I'm going" for an event. Existence means going; there is no status field. After RSVPing the member may answer one follow-up — what they're coming to do — which is what the attendee list groups by.

**Sheet:** `event-rsvps`
**Path template:** `event-rsvps/${year}/${eventSlug}/${personSlug}.toml` — all three are fields of the record; `year` is the event's partition year and moves with the event

The composite path makes "who's going to event X" a directory scan and "has this person RSVP'd" a path-exists test, and the year partition keeps the top-level directory bounded the same way `events/` is. Renaming an event's slug moves its RSVP files in the same commit.

| Field | Type | Notes |
| ------- | ------ | ------- |
| id | uuid | |
| year | string | the event's partition year (`YYYY` of its `startsAt`, the same rule as the event's own path); path field |
| eventSlug | string | references `events.slug`; path field |
| personSlug | string | references `people.slug`; path field |
| plan | enum nullable | `newcomer` ("I'm new to Code for Philly") \| `no_project` ("I don't have a project yet") \| `project` ("I'm coming to work on …"). Absent until the member answers the follow-up. |
| projectId | uuid nullable | references projects.id; required iff `plan = project`, absent otherwise |
| createdAt | iso8601 | when the member RSVP'd; attendee list order |
| updatedAt | iso8601 | |

**Secondary in-memory indices:**

- `rsvpsByEvent: Map<eventSlug, Set<rsvpId>>` — implicit in the path template; cached for counts
- `rsvpsByPerson: Map<personSlug, Set<rsvpId>>` — person purge cascade and (future) "my events"

**Uniqueness:** `(eventSlug, personSlug)`.

RSVP records are **public** (they live in the public data repo and drive the attendee list). They are retained on cancel and when the event ends; they are removed on event hard-delete and on person purge.

## SlugHistory

Records past slugs of an entity to power the 90-day redirect window. See [behaviors/slug-handles.md](behaviors/slug-handles.md).

**Sheet:** `slug-history`
**Path template:** `slug-history/${entityType}/${oldSlug}.toml`

| Field | Type | Notes |
| ------- | ------ | ------- |
| id | uuid | |
| entityType | enum | `project` \| `person` \| `tag` \| `buzz` \| `event` \| `event_series` |
| oldSlug | string | the previous slug, used as the filename |
| newSlug | string | the current canonical slug |
| entityId | uuid | the entity's id (so we can re-resolve even if the slug has moved again) |
| changedAt | iso8601 | |
| expiresAt | iso8601 | `changedAt + 90 days`. After this, the redirect is no longer served. |

A periodic in-process task deletes expired entries.

## Audit log

The audit log is the **commit log of the data repo** — there is no separate `staff-actions` (or any other) audit sheet. Every mutation lands as a structured commit with author, timestamp, diff, and trailers; queries that an audit table would serve (`who soft-deleted project X?`, `recent staff actions this month?`) are answered by `git log --grep`, `git log --author`, and `git log -- <sheet-path>/`.

See [behaviors/storage.md](behaviors/storage.md#commits-are-the-audit-log) for the commit message + trailer convention.

## Relationships at a glance

| From | To | Cardinality | Field |
| ------ | ---- | -----------: | ---- |
| Project | Person | many-to-one (maintainer) | `Project.maintainerId` |
| ProjectMembership | Project | many-to-one | `ProjectMembership.projectSlug` |
| ProjectMembership | Person | many-to-one | `ProjectMembership.personSlug` |
| ProjectUpdate | Project | many-to-one | `ProjectUpdate.projectSlug` |
| ProjectUpdate | Person | many-to-one (author) | `ProjectUpdate.authorId` |
| ProjectBuzz | Project | many-to-one | `ProjectBuzz.projectSlug` |
| ProjectBuzz | Person | many-to-one (postedBy) | `ProjectBuzz.postedById` |
| BlogPost | Person | many-to-one (author) | `BlogPost.authorId` |
| HelpWantedRole | Project | many-to-one | `HelpWantedRole.projectSlug` |
| HelpWantedRole | Person | many-to-one (postedBy / filledBy) | `HelpWantedRole.postedById`, `filledById` |
| HelpWantedInterestExpression | HelpWantedRole | many-to-one | `roleId` |
| HelpWantedInterestExpression | Person | many-to-one | `personSlug` |
| TagAssignment | Tag | many-to-one | `tagId` |
| TagAssignment | Project \| Person \| HelpWantedRole \| BlogPost | polymorphic | `taggableType + taggableId` |
| Event | Person | many-to-one (createdBy) | `Event.createdById` |
| Event | EventSeries | many-to-one, optional | `Event.seriesId` |
| EventRsvp | Event | many-to-one | `EventRsvp.eventSlug` |
| EventRsvp | Person | many-to-one | `EventRsvp.personSlug` |
| EventRsvp | Project | many-to-one, optional | `EventRsvp.projectId` |

Cascading deletes are not enforced by gitsheets; the API's mutation services delete dependent records as part of the same write-and-commit operation (see [behaviors/storage.md](behaviors/storage.md) for atomicity). For project delete this means: in one mutation, write the project's tombstone (`deletedAt`) and (for cascade-on-hard-delete) the dependent project-memberships, project-updates, project-buzz, help-wanted-roles, and tag-assignments are removed. Event hard-delete removes its event-rsvps; person purge removes the person's event-rsvps; a project hard-delete nulls `projectId` on any event-rsvps that pointed at it.

## Naming map: laddr → rewrite

| laddr (PHP/MySQL) | rewrite (gitsheets/TOML) |
| --- | --- |
| `projects.ID` | `projects` record's `id` (uuid) + `legacyId` (int) |
| `projects.Handle` | `projects.slug` |
| `projects.Title` | `projects.title` |
| `projects.README` | `projects.overview` (renamed: GitHub READMEs are a different thing; see [deferred.md](deferred.md#cached-github-readme-on-project-pages)) |
| `projects.Stage` (TitleCase) | `projects.stage` (lowercase) |
| `projects.MaintainerID` | `projects.maintainerId` |
| `projects.UsersUrl` / `DevelopersUrl` / `ChatChannel` | `projects.usersUrl` / `developersUrl` / `chatChannel` |
| `project_members` | `project-memberships` sheet |
| `project_updates.Number` | `ProjectUpdate.number` |
| `project_buzz.Headline` / `URL` / `Published` / `Summary` / `ImageID` | `ProjectBuzz.headline` / `url` / `publishedAt` / `summary` / `imageKey` |
| `tags.Handle` (e.g., `topic.transit`) | `tags.namespace = 'topic'`, `tags.slug = 'transit'` |
| `blog_posts.ID` | `blog-posts` record's `id` (uuid) + `legacyId` (int) |
| `blog_posts.Handle` | `BlogPost.slug` |
| `blog_posts.Title` / `Summary` / `Body` | `BlogPost.title` / `summary` / `body` |
| `blog_posts.AuthorID` / `Published` / `Modified` | `BlogPost.authorId` / `postedAt` / `editedAt` |
| `tag_items.ContextClass` / `ContextID` | `tag-assignments.taggableType` / `taggableId` |
| `Emergence\People\Person.Username` | `Person.slug` (public) — also seeds the immutable `slackSamlNameId` for Slack SSO stability |
| `Emergence\People\Person.Email` | **`PrivateProfile.email`** in the private store (not in the public gitsheets repo) |
| `Emergence\People\Person.AccountLevel` | `Person.accountLevel` (public) |
| `Emergence\People\Person.AccountLevel` value `User` | `accountLevel = 'user'` (anonymous is _no record_, not a stored level) |
| `Emergence\People\Person.Password` (any laddr-era hashed password column) | **`LegacyPasswordCredential.passwordHash`** in the private store. Read-only at runtime; consumed only by the account-claim flow; deleted on successful claim. |
| `tbl_user_subscriptions` / MailChimp opt-in state | **`PrivateProfile.newsletter`** in the private store |
| Database tables | gitsheets sheets |
| `INDEX`, `UNIQUE INDEX` | enforced in-process by the API under the write mutex; backed by in-memory indices built at boot |
| `FOREIGN KEY ... ON DELETE CASCADE` | atomic multi-record gitsheets commit (see Storage spec) |
| `events.Handle` / `Title` / `Description` (a laddr "event" was a whole program) | `EventSeries.slug` / `title` / `description` |
| `event_segments` grouped by calendar day (`LocationName` / `LocationAddress` of the day's first segment) | one `Event` per day in that series: `venueName` / `venueAddress`, `startsAt`/`endsAt` spanning the day's segments, slug `<YYYY-MM-DD>-<series slug>` |
| `event_segments.Title` / `StartTime` / `EndTime` / `Summary` + `Description` | `Event.agenda[]` items on that day's event: `title` / `startsAt` / `endsAt` / `description` (summary and description concatenated) |
| Meetup.com RSVPs (never in laddr's DB) | `event-rsvps` sheet |
| `member_checkins` | _dropped — see [deferred.md](deferred.md)_ |
| `Emergence\CMS\BlogPost` | _dropped — see [deferred.md](deferred.md)_ |
