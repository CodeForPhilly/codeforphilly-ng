# Behavior: Slug Handles

## Rule

Every user-facing entity has a stable, URL-safe **slug** (called `Handle` in laddr). Slugs identify the entity in URLs and API paths; they are mutable but with redirects and uniqueness guarantees.

## Applies To

- [data-model.md](../data-model.md) — `slug` column on `people`, `projects`, `tags`, `projectBuzz`
- [api/projects.md](../api/projects.md), [api/people.md](../api/people.md), [api/tags.md](../api/tags.md), [api/projects-buzz.md](../api/projects-buzz.md)
- Every screen with a path-segment identifier

## Format rules

| Entity | Pattern | Length | Examples |
| ------ | ------- | -----: | -------- |
| Project | `^[a-z0-9][a-z0-9-_]{1,79}$` | 2–80 | `squadquest`, `clean-and-green-philly`, `philly_bike_action` |
| Person | `^[a-z0-9][a-z0-9-]{1,49}$` | 2–50 | `chris`, `janedoe` |
| Tag | `^[a-z0-9][a-z0-9-]{0,49}$` | 1–50 | `transit`, `flutter`, `civic-engagement` |
| Buzz | `^[a-z0-9][a-z0-9-]{1,99}$` | 2–100 | `inquirer-praises-foo` |

Project slugs allow underscores because legacy laddr handles used underscores (`philly_bike_action`, `give_schools_-_needs_board`). New project slugs from the UI default to hyphens; underscores are tolerated for back-compat. Person and tag slugs are hyphens-only — laddr's were already consistent.

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

Uniqueness violation on create or rename → `409 conflict`.

## Mutability and redirects

Slugs **can** change. When they do:

- The entity record's `slug` field is updated.
- A `SlugHistory` record is written to the `slug-history` sheet (see [data-model.md](../data-model.md#slughistory)) with `oldSlug`, `newSlug`, `entityType`, `entityId`, `changedAt`, and `expiresAt = changedAt + 90 days`.
- On any request to a URL using an `oldSlug` that is *not yet* expired, the web layer serves a **301 redirect** to the current canonical URL.
- After `expiresAt`, the redirect is no longer served. The record is retained as part of the commit history but is removed from the sheet by a periodic sweeper task.

Edge cases:

- If a `SlugHistory.oldSlug` is itself a currently-active slug of a *different* entity (someone took the freed slug), the current slug wins — no redirect.
- If a project is renamed A → B → C, both A and B redirect to C until they each expire.

## Reserved slugs

The following are reserved and not allowed for any entity:

- `new`, `create`, `edit`, `delete`, `restore` — used as path segments in CRUD URLs
- `me`, `current`, `self` — reserved for "current user" semantics
- `admin`, `staff`, `system` — reserved
- Any string starting with `_` — reserved for system / internal paths
- Any string that exactly matches an existing top-level route (`projects`, `members`, `tags`, `help-wanted`, `login`, `register`, etc.)

The reserved list is enforced in validators and surfaces as `422 validation_failed` with `error.code = "slug_reserved"`.

## Migration from laddr

- laddr `projects.Handle`, `Emergence\People\Person.Username`, `tags.Handle` (after splitting namespace) — copied directly into `slug`
- Slug format is preserved as-is in the import (uppercase letters lowercased; whitespace replaced with hyphens)
- The `slug-history` sheet is empty after the initial import — the first-90-days redirect window starts the day a slug is changed on the new system
- Legacy URLs from the old system continue to work because we preserve slugs verbatim; the redirect machinery only kicks in for *future* renames
