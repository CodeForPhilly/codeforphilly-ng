# Behavior: Slug Handles

## Rule

Every user-facing entity has a stable, URL-safe **slug** (called `Handle` in laddr). Slugs identify the entity in URLs and API paths; they are mutable but with redirects and uniqueness guarantees.

## Applies To

- [data-model.md](../data-model.md) — `slug` column on `people`, `projects`, `tags`, `projectBuzz`, `events`
- [api/projects.md](../api/projects.md), [api/people.md](../api/people.md), [api/tags.md](../api/tags.md), [api/projects-buzz.md](../api/projects-buzz.md), [api/events.md](../api/events.md)
- Every screen with a path-segment identifier

## Format rules

| Entity | Pattern | Length | Examples |
| ------ | ------- | -----: | -------- |
| Project | `^[a-z0-9][a-z0-9-_]{1,79}$` | 2–80 | `squadquest`, `clean-and-green-philly`, `philly_bike_action` |
| Person | `^[a-z0-9][a-z0-9-]{1,49}$` | 2–50 | `chris`, `janedoe` |
| Tag | `^[a-z0-9][a-z0-9-]{0,49}$` | 1–50 | `transit`, `flutter`, `civic-engagement` |
| Buzz | `^[a-z0-9][a-z0-9-]{1,99}$` | 2–100 | `inquirer-praises-foo` |
| Event | `^[a-z0-9][a-z0-9-_]{1,99}$` | 2–100 | `2026-11-03-hack-night`, `launchpad_2019` |
| Event series | `^[a-z0-9][a-z0-9-]{1,99}$` | 2–100 | `monthly-hack-nights`, `launchpad` |

Event slugs default to `<YYYY-MM-DD>-<slugified title>` (date in `America/New_York`) so the sheet directory lists chronologically. Underscores are tolerated for the same reason as projects: one backfilled laddr event (`launchpad_2019`) has one. See [events.md](events.md).

Project slugs allow underscores because legacy laddr handles used underscores (`philly_bike_action`, `give_schools_-_needs_board`). New project slugs from the UI default to hyphens; underscores are tolerated for back-compat. Person and tag slugs are hyphens-only; legacy handles that didn't fit were normalized at import (see [Migration from laddr](#migration-from-laddr)).

## Generation

- **Default** — slugify the entity's display name:
  - Lowercase
  - Replace runs of non-`[a-z0-9]` with a single hyphen
  - Trim leading/trailing hyphens
  - Truncate to the entity's max length
- If the slugified result collides with an existing slug, append `-2`, `-3`, … until unique
- Users can override the default at create time

## Uniqueness

| Entity | Unique within |
| ------ | ------------- |
| Project | All projects (case-insensitive). Includes soft-deleted projects — restoring a project must not have its slug taken. |
| Person | All people (case-insensitive). Includes soft-deleted. |
| Tag | `(namespace, slug)` — different namespaces can reuse the same slug |
| Buzz | All buzz across all projects |
| Event | All events (case-insensitive) |
| Event series | All series (case-insensitive) |

Uniqueness violation on create or rename → `409 conflict`.

## Mutability and redirects

Slugs **can** change. When they do:

- The entity record's `slug` field is updated.
- The entity's attachments (avatar, featured image) move with the record, and any on-record attachment key (`avatarKey`, `featuredImageKey`) is rewritten to the new path. A rename changes the handle and nothing else about the entity.
- A `SlugHistory` record is written to the `slug-history` sheet (see [data-model.md](../data-model.md#slughistory)) with `oldSlug`, `newSlug`, `entityType`, `entityId`, `changedAt`, and `expiresAt = changedAt + 90 days`.
- On any request to a URL using an `oldSlug` that is *not yet* expired, the web layer serves a **301 redirect** to the current canonical URL.
- After `expiresAt`, the redirect is no longer served. The record is retained as part of the commit history but is removed from the sheet by a periodic sweeper task.

Edge cases:

- If a `SlugHistory.oldSlug` is itself a currently-active slug of a *different* entity (someone took the freed slug), the current slug wins — no redirect.
- If a project is renamed A → B → C, both A and B redirect to C until they each expire.

### Legacy handle normalization

laddr matched handles case-insensitively, and the import normalized handles that didn't fit the format rules (see [Migration from laddr](#migration-from-laddr)). So inbound links in the wild carry the *pre-normalization* form, e.g. `/projects/Apps_for_Philly`, `/projects/sheldon.md`, `/members/Jane_Doe`. These redirect **permanently**, with no `SlugHistory` record and no expiry:

- On a web request for an entity URL whose slug is neither live nor in `slug-history`, apply the **legacy normalization** for that entity type and retry the lookup:
  - Lowercase
  - Replace each run of characters outside the entity's allowed set (`[a-z0-9_-]` for projects and events, `[a-z0-9-]` otherwise) with a single hyphen
  - Trim leading and trailing `-` and `_`
  - Truncate to the entity's max length
  - If the result doesn't start with `[a-z0-9]`, prefix `s`
- If the normalized slug is live (or resolves through `slug-history`), serve a **301** to the canonical URL, preserving any path suffix and query string.
- Otherwise fall through to the normal not-found handling.

The normalization is the import's transform minus its collision suffixing. A legacy handle whose normalized form collided at import (it was imported as `<slug>-2`) redirects to the entity that holds the unsuffixed slug. That's an accepted limit; laddr's case-insensitive uniqueness means case-only collisions can't occur, so only punctuation collisions are affected.

The API does not normalize. `/api/*` lookups are exact-match on the canonical slug; clients always hold canonical slugs.

## Reserved slugs

The following are reserved and not allowed for any entity:

- `new`, `create`, `edit`, `delete`, `restore` — used as path segments in CRUD URLs
- `me`, `current`, `self` — reserved for "current user" semantics
- `admin`, `staff`, `system` — reserved
- `past`, `upcoming`, `all`, `feed`, `series` — reserved; sibling list views, feeds, and sub-collections under a collection route (`/events/past`, `/api/events/feed.ics`, `/events/series/<slug>`)
- Any string starting with `_` — reserved for system / internal paths
- Any string that exactly matches an existing top-level route (`projects`, `members`, `tags`, `help-wanted`, `login`, `register`, etc.)

The reserved list is enforced in validators and surfaces as `422 validation_failed` with `error.code = "slug_reserved"`.

## Migration from laddr

- laddr `projects.Handle`, `Emergence\People\Person.Username`, `tags.Handle` (after splitting namespace) become `slug` after the legacy normalization in [Legacy handle normalization](#legacy-handle-normalization), plus `-2`, `-3`, … suffixing on collision. At the 2026-09-08 import, 66 of 269 project handles changed: 63 by case alone, 3 by punctuation or truncation.
- The `slug-history` sheet is empty after the initial import. Import-time normalization is **not** recorded there, since those redirects must never expire. The 90-day redirect window applies only to renames on the new system.
- Legacy URLs keep working through the legacy normalization fallback above.
