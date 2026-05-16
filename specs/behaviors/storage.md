# Behavior: Storage

## Rule

Persistent data lives in a **gitsheets-backed git repository** — TOML records in templated paths, committed atomically. There is no relational database. At runtime the API loads all records into typed in-memory structures and serves reads from there; mutations write to the gitsheets repo and update the in-memory state synchronously.

## Applies To

- Everything in [data-model.md](../data-model.md) — every entity is a gitsheets record
- [architecture.md](../architecture.md) — process model, deploy, dev experience
- [behaviors/legacy-id-mapping.md](legacy-id-mapping.md) — `legacyId` lookups happen against the in-memory state
- [behaviors/activity-feed.md](activity-feed.md) — feed composition is an in-memory merge
- [api/conventions.md](../api/conventions.md) — pagination/sort/filter are JS operations over in-memory state

## Process model

Single-replica Fastify API. Mutations are serialized in-process by an async mutex on the gitsheets repo write path. No multi-pod scaling in v1.

```
┌────────────────────────────────────────────────────────────────────┐
│                      Fastify API (1 replica)                       │
│                                                                    │
│   ┌──────────────┐    ┌─────────────────────┐    ┌──────────────┐  │
│   │ Route handler│──▶ │ In-memory state     │ ─▶ │ FTS index    │  │
│   │              │    │ (Map<id, Record>    │    │ (SQLite      │  │
│   │              │    │  per sheet)         │    │  in-memory)  │  │
│   └──────┬───────┘    └──────────┬──────────┘    └──────────────┘  │
│          │                       ▲                                 │
│          │ (write)                │ (refresh on commit)             │
│          ▼                       │                                 │
│   ┌──────────────────────┐       │                                 │
│   │ gitsheets writer     │───────┘                                 │
│   │ (async mutex)        │                                         │
│   └──────────┬───────────┘                                         │
│              │                                                     │
└──────────────┼─────────────────────────────────────────────────────┘
               │ (commit)
               ▼
    ┌─────────────────────────────────────┐    ┌──────────────────┐
    │ Working git repo on disk            │ ─▶ │ GitHub remote    │
    │ (volume / PVC)                      │    │ (async push)     │
    └─────────────────────────────────────┘    └──────────────────┘
```

## Repositories

There are two git repositories:

| Repo | Purpose | Visibility |
| ---- | ------- | ---------- |
| `codeforphilly-rewrite` | The application code (this repo) | Public |
| `codeforphilly-data` | The live gitsheets data | **Private** — contains emails, real names, IPs |

The code repo references the data repo by env (`CFP_DATA_REPO_PATH`). They are not git submodules — too much friction. They're sibling working trees.

### Dev-environment data

A scrubbed snapshot of the data repo is published as a public tag (e.g., `snapshot-2026-q2-scrubbed`) on a separate public repo `codeforphilly-data-snapshot`. Scrubbing:

- Emails → `<slug>@example.invalid`
- Real names → faker-generated names
- IP addresses → `0.0.0.0`
- `slackHandle` → null
- `bio`, `readme`, `body` content → unchanged (assumed safe; staff may flag specific records for redaction)

A `scripts/scrub-data.ts` in the code repo produces the snapshot. The contributor bootstrap is:

```bash
git clone https://github.com/CodeForPhilly/codeforphilly-rewrite.git
git clone https://github.com/CodeForPhilly/codeforphilly-data-snapshot.git ../codeforphilly-data
npm install
npm run dev   # api + web boot, data already there
```

That's the "no moving pieces" win — a contributor sees real-shape data without ever touching a database, and can `git checkout`, `git reset`, or branch to experiment.

## Sheet layout

Each entity lives in one sheet. The path template determines how records are stored on disk.

| Entity | Sheet | Path template |
| ------ | ----- | ------------- |
| Person | `people` | `people/${slug}.toml` |
| Project | `projects` | `projects/${slug}.toml` |
| ProjectMembership | `project-memberships` | `project-memberships/${projectSlug}/${personSlug}.toml` |
| ProjectUpdate | `project-updates` | `project-updates/${projectSlug}/${number}.toml` |
| ProjectBuzz | `project-buzz` | `project-buzz/${projectSlug}/${slug}.toml` |
| HelpWantedRole | `help-wanted-roles` | `help-wanted-roles/${projectSlug}/${id}.toml` |
| HelpWantedInterestExpression | `help-wanted-interest` | `help-wanted-interest/${roleId}/${personSlug}.toml` |
| Tag | `tags` | `tags/${namespace}/${slug}.toml` |
| TagAssignment | `tag-assignments` | `tag-assignments/${tagId}/${taggableType}/${taggableId}.toml` |
| SlugHistory | `slug-history` | `slug-history/${entityType}/${oldSlug}.toml` |
| Revocation | `revocations` | `revocations/${jti}.toml` |
| LegacyPasswordCredential | `legacy-password-credentials` | `legacy-password-credentials/${personId}.toml` |

### Why these path shapes

The path template is the only "index" gitsheets provides natively. Choose it to support the _dominant_ access pattern; in-memory secondary indices handle reverse lookups.

- **Composite paths** (`${projectSlug}/${personSlug}.toml`) make "list everything for this parent" a single directory scan. Reverse lookups ("which projects is this person in?") use an in-memory index built at boot.
- **Time-partitioned paths** keep directory size bounded for sheets that grow monotonically. None of the v1 sheets currently use time partitioning, but the pattern is reserved for future high-volume sheets (e.g., webhook ingestion logs).
- **Polymorphic paths** (`tag-assignments/${tagId}/${taggableType}/${taggableId}.toml`) make "tags on this thing" require an inverted in-memory index. The forward direction ("things with this tag") is the dominant query and matches the path template.

### Record format

Records are TOML. Example:

```toml
# people/janedoe.toml
id          = "01951a3c-8901-7000-8000-000000000042"
legacyId    = 1234
slug        = "janedoe"
email       = "jane@example.com"
fullName    = "Jane Doe"
firstName   = "Jane"
lastName    = "Doe"
bio         = """
Markdown source here
"""
avatarKey   = "people-avatars/01951a3c-8901-7000-8000-000000000042/orig.jpg"
slackHandle = "janedoe"
accountLevel    = "user"
emailVerifiedAt = "2024-01-15T18:42:00Z"
createdAt       = "2024-01-15T18:42:00Z"
updatedAt       = "2024-01-15T18:42:00Z"
```

Field names match the in-memory representation. Nulls are omitted (TOML can't represent `null`; treat absence as null).

### Attachments

Binary blobs (avatars, buzz images, featured-project hero images) live alongside their owning record via gitsheets' `setAttachment` API. Concretely, attachments land at predictable paths next to the record:

```
people/janedoe.toml
people/janedoe/avatar.jpg
people/janedoe/avatar-128.jpg
```

The on-record key (`avatarKey`) references the attachment path relative to the data repo root. Web serves attachments via a streamed `GET /api/attachments/<key>` route with cache headers.

## In-memory representation

At boot the API reads every blob in every sheet, parses TOML, validates against the Zod schemas in `packages/shared`, and constructs a typed in-memory representation:

```typescript
type Store = {
  people:                 Map<UUID, Person>
  projects:               Map<UUID, Project>
  projectMemberships:     Map<UUID, ProjectMembership>
  // …one Map per sheet…

  // Secondary indices built at boot:
  bySlug: {
    person:  Map<string, UUID>
    project: Map<string, UUID>
    tag:     Map<string /* namespace.slug */, UUID>
  }
  byLegacyId: {
    person:  Map<number, UUID>
    project: Map<number, UUID>
    // …
  }
  membershipsByPerson:  Map<UUID, UUID[]>  // person.id → membership.id[]
  membershipsByProject: Map<UUID, UUID[]>
  tagsByAssignment:     Map<string /* type:id */, UUID[]>
  assignmentsByTag:     Map<UUID, Array<{ type, id }>>
  // …etc, one per access pattern that needs a non-path-template direction
}
```

Mutations are scoped to the HTTP request — see the [Request-bound commit lifecycle](#request-bound-commit-lifecycle) below.

## Commits are the audit log

There is no separate audit-log table or sheet. Every mutation is a git commit with author, timestamp, full diff, structured message, and trailers. Queries that a SQL audit log would serve (`who soft-deleted project X?`, `recent staff actions this month?`) are answered by `git log --grep`, `git log --author`, and `git log -- path/to/sheet/`.

This is a load-bearing decision. It saves us a sheet, and it makes the data repo's full mutation history first-class — visible in `git log`, scriptable, scrubbable, and naturally tamper-evident.

### Request-bound commit lifecycle

Each state-mutating HTTP request produces exactly one commit, built from the request context. **Commit only on success** — if the handler throws, no commit lands.

A Fastify hook wraps every request that could mutate state:

1. Acquire the per-process write mutex.
2. Open a tree-writer over the current data tree.
3. Run the handler. The handler stages writes via the gitsheets API but does not commit.
4. After the handler resolves:
   - **If it succeeded AND the tree was modified** — finalize the commit (author, message, trailers, parent), update the in-memory store + secondary indices + FTS index, release the mutex, schedule an async push.
   - **If it threw OR the tree is unchanged** — discard staged writes, release the mutex, no commit.

Read-only handlers (`GET`, `HEAD`, `OPTIONS`) skip the mutex and the commit machinery entirely.

A mutation thus either fully succeeds (gitsheets commit + in-memory update + scheduled push) or fully fails (nothing persists). The mutex makes the handler's view of state stable for the duration of the request.

### Commit message shape

```text
<actor-slug>: <method> <path>

<optional human-readable summary or rendered request/response snippet>

Action: <namespaced action, e.g. project.soft-delete>
Subject-Type: <project | person | tag | ...>
Subject-Id: <uuid>
Subject-Slug: <slug>
Actor-Slug: <slug>
Actor-Account-Level: <user | staff | administrator>
Reason: <optional free-form>
Host: <request host>
Content-Type: <request content-type>
User-Agent: <client UA>
User-Ip: <client IP>
Response-Code: <http status>
Response-Message: <http status text>
```

Rules:

- The **subject line** is `<actor-slug>: <method> <path>`. For anonymous requests, the actor segment is `anon`.
- The **author and committer** are the acting Person's `fullName` + `email` (so `git log --author` and `git blame` work without trailer parsing). For anonymous requests, author is `Anonymous <anonymous@codeforphilly.org>`.
- The **trailers** follow git's standard trailer format (parseable by `git interpret-trailers --parse`). Key convention is HTTP-header style: first letter capitalized, multi-word keys hyphenated, rest lowercase. Examples: `Subject-Type`, `User-Agent`, `Response-Code`. Single-word keys: `Action`, `Reason`, `Host`.
- `Action` is namespaced with a dot (`project.soft-delete`, `tag.merge`, `account-level.change`) so trailer filters like `git log --grep='^Action: project\.'` work cleanly.
- Trailers describe the request and the semantic action together. There's no separate "regular commit" vs "audit commit" format — every mutation is audit-loggable.

### PII-aware redaction

The data repo is private, but redaction is defense-in-depth:

- `Authorization` and `Cookie` request headers are never logged.
- Any request body field matching `/password|token|secret/i` is replaced with `[REDACTED]` before embedding in the commit message.
- `Set-Cookie` response headers and JWT bodies are not embedded.

The scrubbed public snapshot (see [Dev-environment data](#dev-environment-data)) ships as a single squashed commit without history, so even unredacted history never reaches public.

## Full-text search

Search hits `title + summary + readme` for projects and `fullName + bio` for people (per the API specs). At boot, the API builds an **in-memory SQLite database** (via `better-sqlite3` with `:memory:` or `bun:sqlite` if we end up on bun) with FTS5 virtual tables for projects and people. On every mutation that touches an indexed field, the corresponding row is upserted.

- Throwaway: never persisted, rebuilt on every restart. Boot cost is acceptable at civic scale (<1s for our corpus).
- Engine choice: SQLite FTS5 has built-in ranking, prefix matching, and BM25 scoring — equivalent to what Postgres `tsvector` would give us.
- Fallback: for v1 we may ship with **MiniSearch** (a few KB of JS, no native deps) and escalate to SQLite FTS5 only if MiniSearch's ranking is insufficient. Either choice is invisible to callers — the `?q=` API doesn't change.

## Sync to GitHub

After every commit, an async background task pushes to the configured `origin` (the private `codeforphilly-data` GitHub repo). Pushes are non-blocking — the mutation returns to the caller as soon as the local commit lands.

- If a push fails (network blip, GitHub outage), it's retried with exponential backoff up to a 1-hour ceiling.
- If retries are still failing after 1 hour, the API logs an error and emits a Prometheus alert metric. The local commit history is intact; the remote just catches up later.
- No commits are ever rewritten or force-pushed by the runtime. The data repo is append-only from the API's perspective.

## Concurrency on the data repo

We expect three writer concurrency cases. They all collapse onto the single in-process mutex:

| Case | Behavior |
| ---- | -------- |
| Two HTTP requests racing | Serialized by the mutex; second waits for first. |
| API restart with pending push | On boot, push any unpushed local commits. |
| Direct edit to the working repo by a developer | Disallowed in production. In dev it's intentional — developers can `git commit` against the data repo to seed state. The API's in-memory state will drift until restart; a `--watch` flag is desirable but not required for v1. |

## Schema migrations

Adding a field: the new field is optional in the Zod schema; older records have the field absent (treated as null). The next time a record is updated through the API, the field gets written. No migration step required.

Renaming or removing a field: write a one-shot migration script that reads every record in the sheet, transforms each, and commits the lot as one tree write. The migration is a normal commit in the data repo's history — reviewable and revertable.

Migration scripts live in `apps/api/scripts/migrations/<timestamp>-<description>.ts`. They are not auto-run; staff run them explicitly during a maintenance window. Run history is tracked by checking for the migration's commit in the data repo's log.

## Boot sequence

```
1. Connect to local gitsheets repo (CFP_DATA_REPO_PATH)
2. For each sheet declared in the schema:
   a. Iterate every blob under the sheet's path
   b. Parse TOML, validate Zod schema, build Map<id, Record>
3. Build secondary in-memory indices
4. Build FTS index from indexed records
5. Start serving HTTP
```

At our corpus size (~5,000 records, mostly small), boot is sub-second on a modest container. Boot time grows linearly with corpus size; at 50K records expect 5–10s. If that becomes painful, partition the read or cache the in-memory representation to disk — but neither is needed at civic scale.

## Disaster recovery

The data repo is git. Recovery from total local loss:

```bash
git clone <origin> codeforphilly-data
```

The API reads from this fresh clone on next boot. Lost = at most the writes since the last push (which, given async background pushing, may be seconds of writes).

For RPO < 1s, set push to synchronous mode (`CFP_DATA_PUSH_MODE=sync`). The mutation latency cost is a network round-trip to GitHub on every write; only enable if the data-loss budget demands it.

## What this is NOT

- **Not a multi-tenant or multi-writer store.** Single Fastify replica is a hard requirement. Horizontal scaling would require a writer-leader election or sharded data repos — out of scope.
- **Not a real-time collaboration platform.** Updates from one client are visible to others only after the API instance has finished its mutation. No WebSocket fan-out from gitsheets.
- **Not a long-term audit-log compaction strategy.** Every mutation is a commit forever. Repo size grows monotonically. At civic scale this is fine; at 10×–100× the volume, `git filter-repo` becomes a periodic-maintenance step.
