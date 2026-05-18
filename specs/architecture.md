# Architecture

Foundational tech decisions for the codeforphilly.org rewrite. Everything downstream — schemas, screens, deployment — depends on these.

## Goal

A 1:1 modernization of [laddr](https://github.com/CodeForPhilly/laddr) as customized for [codeforphilly.org](https://codeforphilly.org). Same product surface, healthier foundation. Extending v1 features with a new **help-wanted roles** capability so project maintainers can advertise concrete asks.

Out of scope for v1: see [deferred.md](deferred.md).

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Backend framework | **Fastify 5.x + TypeScript** | Per `backend-fastify` skill. Plugin model maps cleanly to laddr's RequestHandler hierarchy. Schema-validated routes replace ad-hoc PHP validation. |
| Frontend framework | **Vite + React 19 + TypeScript** | Per `frontend-shadcn` skill. SPA for the dynamic surface; SSR not required for v1 (search engines find existing project pages via sitemap). |
| Routing (web) | **React Router v7** | Per skill. Use `react-router` (not `react-router-dom`). |
| UI components | **shadcn/ui (New York) + Tailwind v4** | Per skill. Replaces Bootstrap 4 + jQuery widgets from laddr. |
| Public storage | **gitsheets** (git-backed TOML record store) | No persistent OLTP. Records committed atomically to a git repo; pushed to GitHub for backup. Single-replica API loads all data into typed in-memory state on boot. Public-by-design — drives the civic-transparency win and free contributor onboarding via scrubbed snapshot. See [behaviors/storage.md](behaviors/storage.md). |
| Private storage | **S3-compatible bucket** (or filesystem in dev) | A small bucket holds private/sensitive data — email addresses, legacy password hashes during migration, newsletter subscription state. Two `.jsonl` files total. Boot-load + in-memory; PUT on mutation. Dev mode uses a local filesystem backend so contributors never touch production private data. See [behaviors/private-storage.md](behaviors/private-storage.md). |
| Schema validation | **Zod** | Shared schemas in `packages/shared` validate records on read and write (both stores), plus all API request/response shapes. The single source of types — no ORM in the stack. |
| Full-text search | **SQLite FTS5 (in-memory)** | Throwaway index built at boot from gitsheets state. Rebuilt incrementally on mutation. Possible v1 fallback to MiniSearch if SQLite native-dep cost is unwanted. |
| Markdown | **`unified` + `remark` + `rehype-sanitize`** | Replaces laddr's Markdown_AutoLink. Renders on the server to a sanitized HTML string; the client just displays it. |
| Auth | **GitHub OAuth + `@fastify/jwt` + `@fastify/cookie`** | GitHub is the sole primary identity provider (no email/password). Sessions are stateless JWTs. See [api/auth.md](api/auth.md) + [behaviors/authorization.md](behaviors/authorization.md). |
| File uploads (avatars, buzz images) | **gitsheets attachments** | Binary blobs stored alongside their record via gitsheets' `setAttachment` API; served via streaming `GET /api/attachments/<key>`. |
| Background jobs | **In-process timers + an in-memory queue** | At single-replica civic scale we don't need Redis/BullMQ for fan-out. Image thumbnailing, scheduled rollups, and async git pushes run in the same process. |
| Logging | **pino** (Fastify default) | Pretty in dev, JSON in prod. |
| Email | **Resend** (transactional) | For notifications like "help wanted interest expressed" and newsletter delivery (when that ships). Service account, not per-user OAuth. |

### What we deliberately *don't* use

- **PostgreSQL / any persistent OLTP** — see [deferred.md](deferred.md). Civic scale lets us hold the whole corpus in memory and rebuild search at boot. Avoiding a separate database collapses ops surface to "one container plus a git remote."
- **An ORM / migration tool (Drizzle, Prisma)** — gitsheets records are TOML; Zod schemas are the validation layer. Schema migrations are one-shot scripts committed to the data repo, reviewable like any other change.
- **Redis / BullMQ** — at single-replica scale, in-process timers and async tasks are enough. If we ever scale to multiple writers, that decision triggers a re-architecture, not just adding Redis.
- **Object storage for attachments** — gitsheets attachments live next to their owning record, committed atomically. The cost is repo size; the benefit is one less service to operate. (Private structured data does use an S3-compatible bucket — see [behaviors/private-storage.md](behaviors/private-storage.md). Two narrow `.jsonl` files; not a general-purpose blob store.)
- **Next.js / SSR** — SPA is enough for v1; SSR can be added later if SEO becomes a measurable problem
- **GraphQL** — REST + zod-typed JSON is sufficient for the surface area
- **A separate admin app** — admin actions are gated routes within the same app
- **Multi-tenancy / multi-brigade extensibility** — laddr's "extend" pattern (hologit overlays) is dropped; this is a single-tenant codeforphilly.org app. If another brigade wants the codebase later, they fork.
- **Multiple API replicas** — gitsheets writes are serialized in-process. Horizontal scaling needs a writer-leader story we don't have. Single replica is *intentional* and adequate for civic scale.

## Repository layout

Two git repositories side by side:

```text
~/Repositories/
├── codeforphilly-rewrite/    # this repo — application code, public
└── codeforphilly-data/        # gitsheets data, private
```

The code repo references the data repo by env var (`CFP_DATA_REPO_PATH`). They are not submodules. See [behaviors/storage.md](behaviors/storage.md).

For contributor onboarding, a public scrubbed snapshot is published at `codeforphilly-data-snapshot` — emails pseudonymized, IPs zeroed. Contributors clone that instead of the live data repo.

### Code repo (this one)

```text
codeforphilly-rewrite/
├── apps/
│   ├── web/                  # Vite + React + shadcn frontend
│   │   ├── src/
│   │   │   ├── components/   # ui/ from shadcn, plus app components
│   │   │   ├── pages/        # Route-level components
│   │   │   ├── hooks/        # useApi, useAuth, etc.
│   │   │   ├── lib/          # utils, api client
│   │   │   ├── App.tsx
│   │   │   └── main.tsx
│   │   └── index.html
│   └── api/                  # Fastify + TypeScript backend
│       ├── src/
│       │   ├── plugins/      # env, gitsheets, auth, cors
│       │   ├── routes/       # One file per endpoint group; mirrors specs/api/
│       │   ├── services/     # Business logic (ProjectService, TagService, etc.)
│       │   ├── store/        # In-memory store + secondary indices + FTS
│       │   ├── jobs/         # In-process scheduled tasks (push, thumbnails)
│       │   ├── app.ts
│       │   └── index.ts
│       └── scripts/
│           ├── import-laddr.ts            # one-shot mysqldump → gitsheets
│           ├── scrub-data.ts              # produce public anonymized snapshot
│           └── migrations/<timestamp>-*.ts  # schema migration scripts
├── packages/
│   └── shared/               # Zod schemas + TypeScript types shared web↔api
│       └── src/
├── specs/                    # ← source of truth
├── .claude/
│   ├── CLAUDE.md             # authorship + tooling conventions
│   ├── agents/               # spec-drift-auditor
│   └── commands/             # /audit-spec-drift
├── README.md
├── package.json              # npm workspaces
├── tsconfig.base.json
└── .tool-versions            # asdf-managed node version
```

### Data repo

```text
codeforphilly-data/
├── .gitsheets/               # per-sheet config TOML files
│   ├── people.toml
│   ├── projects.toml
│   └── …
├── people/<slug>.toml        # records, per the path templates in storage.md
├── projects/<slug>.toml
├── projects/<slug>/<attachment>
├── project-memberships/<projectSlug>/<personSlug>.toml
└── …
```

### Why monorepo (code side)

The web and api share Zod schemas for every request/response shape and every record. Putting them in `packages/shared` means the frontend gets compile-time type safety against the backend without a separate codegen step or OpenAPI roundtrip. The same Zod schemas validate records on read from gitsheets.

### Workspace tool

`npm` workspaces. Not bun, not pnpm — keeps the deploy story boring and matches the user's preference for `npm` on non-bun JS projects.

## Conventions

- **TypeScript everywhere.** No `.js` files in `src/`. `strict: true` in `tsconfig.base.json`.
- **Field naming** — camelCase in both TypeScript and the TOML records on disk. No SQL casing to map between.
- **IDs** — UUIDv7 for all entities. Stable, sortable, k-sortable-by-creation, no leaked count. Migration from laddr's auto-increment IDs is via a `legacyId` field on each migrated record.
- **Slugs** — every user-facing entity has a `slug` (replaces laddr's `Handle`). URL-safe, lowercase, hyphen-separated, unique within their type. See [behaviors/slug-handles.md](behaviors/slug-handles.md).
- **Timestamps** — `createdAt`, `updatedAt` on every record. ISO 8601 UTC strings (`"2026-05-15T18:42:00Z"`) in TOML, the API, and TypeScript.
- **Soft deletes** — only on `projects` and `people` (laddr precedent). The record stays in gitsheets with `deletedAt` set; the in-memory store filters them from non-staff reads.
- **Error envelope** — see [api/conventions.md](api/conventions.md).
- **No null in TOML** — TOML can't represent null. Treat absent fields as null on read; omit nulls on write.

## Build, dev, deploy

### Local development

The "no moving pieces" promise: a contributor needs git, Node, and two clones. No Docker compose, no database to install, no migrations to run.

```bash
git clone https://github.com/CodeForPhilly/codeforphilly-rewrite.git
git clone https://github.com/CodeForPhilly/codeforphilly-data-snapshot.git ../codeforphilly-data
cd codeforphilly-rewrite
npm install
npm run dev              # api + web concurrently with watch
```

The web dev server proxies `/api/*` to the api on `localhost:3001`. Both rebuild on file changes (`tsx watch` for api, Vite HMR for web). The API reads public data from `../codeforphilly-data` by default; override with `CFP_DATA_REPO_PATH`.

Mutations made through the running site land as commits in the local data repo. Contributors can:

- `git diff` to see what their feature changed
- `git reset --hard` to clean slate
- `git checkout -b experiment` to branch state alongside code branches
- Open the data repo in any git client to inspect history

See [behaviors/storage.md](behaviors/storage.md) for the developer-experience details.

**Private data in dev:** the API uses `STORAGE_BACKEND=filesystem` against a local `./private-storage/` directory. Contributors either start empty (sign up via GitHub OAuth during dev) or load a fixture-seeded directory shipped at `fixtures/private-storage-seeded/`. **Real production private data never lands on a dev machine** — see [behaviors/private-storage.md](behaviors/private-storage.md).

### Build

```bash
npm run build            # builds web → apps/web/dist, api → apps/api/dist
npm run type-check       # tsc --noEmit across workspaces
```

### Deploy

A single Docker image bundles the built API and serves the static `apps/web/dist` from the same Fastify instance via `@fastify/static`. One container, one ingress.

Runtime configuration (sealed-secrets in our cluster):

| Env var | Purpose |
| ------- | ------- |
| `CFP_DATA_REPO_PATH` | Local working-tree path for the public gitsheets data repo |
| `CFP_DATA_REMOTE` | git URL to push public data commits to (private GitHub remote intentionally — see [behaviors/storage.md](behaviors/storage.md)). NOTE: this is the *production* data repo; the *public* snapshot is published separately. |
| `STORAGE_BACKEND` | `s3` in production; `filesystem` in dev |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Private-storage bucket config — see [behaviors/private-storage.md](behaviors/private-storage.md) |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth app credentials — see [api/auth.md](api/auth.md) |
| `CFP_JWT_SIGNING_KEY` | HS256 key for session JWTs |
| `SAML_PRIVATE_KEY` / `SAML_CERTIFICATE` | Slack SAML IdP cert chain — see [api/saml.md](api/saml.md) |

On pod start the entrypoint:

1. Runs `git clone` / `git fetch && git reset --hard origin/main` against `CFP_DATA_REMOTE` to populate the data-repo working tree
2. Boots the API, which loads the gitsheets state and the private-storage `.jsonl` files into memory

On every public-side commit the API pushes asynchronously to `CFP_DATA_REMOTE`. On every private-side mutation the API PUTs the relevant `.jsonl` to the bucket synchronously. See the dual-write coordination notes in [behaviors/private-storage.md](behaviors/private-storage.md).

The k8s manifests live in `deploy/kustomize/` as a Kustomize base plus per-environment overlays (`base/`, `overlays/staging/`, `overlays/production/`). Apply with `kubectl apply -k deploy/kustomize/overlays/<env>`. Cluster targeting and secret management are unchanged from the legacy stack — sealed-secrets via [`bitnami-labs/sealed-secrets`](https://github.com/bitnami-labs/sealed-secrets), kubeconfig-per-environment in GitHub Environment secrets. See `docs/operations/migrate-to-k8s.md` in the laddr repo for the cluster-level context.

We deliberately do **not** use Helm. The chart-template indirection is unnecessary for our scope; the variation between environments is small (image tag, ingress host, private-storage backend, secret references) and overlays handle it more legibly than `{{ if }}` blocks in templates. Plain YAML + overlays also matches every other layer of this stack's preference for explicit composition over template substitution.

## Data migration

A one-shot migration script (`apps/api/scripts/import-laddr.ts`) reads from a mysqldump of the production laddr database and writes records into a fresh gitsheets repo. Each record gets a `legacyId` field populated with the laddr auto-increment `ID`, so URLs like `/projects/squadquest` resolve in both systems against the same slug.

The migration is one big commit ("import from laddr `<mysqldump-date>`"). Reviewable, revertable, reusable for staging-cutover dry runs.

The migration is not run in production until the spec for each migrated sheet is accepted. It's a tool for cutover, not a long-term integration.

## Authorization model

Three levels, matching laddr's `Person.AccountLevel`:

| Level | Who | Can |
|-------|-----|-----|
| **Anonymous** | Not signed in | Browse public content; view profiles, projects, updates, buzz |
| **User** | Signed-in member | Update own profile; post project updates on projects they're a member of; post buzz to any project; create new projects (auto-becomes maintainer) |
| **Staff** | Trusted contributor | Edit any project; manage project members; promote help-wanted to highlighted; moderate content |
| **Administrator** | Org leadership | All Staff powers + manage users + irreversible deletes + impersonate |

Authorization rules per endpoint and screen live in the respective spec files, with the cross-cutting policy in [behaviors/authorization.md](behaviors/authorization.md).

**How accounts come into being:** there is no on-site sign-up form. Accounts originate from one of two paths:

- **Laddr migration import** — seeds every existing laddr member as a Person record with their preserved slug, email, and (where applicable) `LegacyPasswordCredential`. These accounts exist but have no JWTs issued yet; the user gets their first session by going through the not-yet-specified GitHub OAuth + account-claim flow.
- **GitHub OAuth, first sign-in** — once the OAuth flow is specified, a new GitHub user signing in for the first time who can't be matched to a legacy account gets a fresh Person record auto-created at `accountLevel = user`.

`Staff` and `Administrator` levels are set by existing administrators, via a hand-authored commit to the data repo until the staff-level endpoint is built.

## Performance budgets

- **Projects index** — first contentful paint < 1.5s, time-to-interactive < 3s on cable broadband
- **API p95** — < 200ms for read endpoints, < 500ms for write endpoints
- **Bundle size** — initial JS < 250 KB gzipped; lazy-load admin and edit views

These are targets, not gates. Violations get a ticket; they don't block release unless they're 2x off.
