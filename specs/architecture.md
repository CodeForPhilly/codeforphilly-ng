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
| Database | **PostgreSQL 16** | Replaces MySQL. Better JSON support, full-text search, range types. Migration path via fresh import of laddr SQL dump. |
| ORM / migrations | **Drizzle ORM** | TypeScript-native, lightweight, supports both SQL-first and code-first migrations. |
| Markdown | **`unified` + `remark` + `rehype-sanitize`** | Replaces laddr's Markdown_AutoLink. Renders on the server to a sanitized HTML string; the client just displays it. |
| Auth | **`@fastify/jwt` + `@fastify/cookie`** | Email/password primary. Slack OAuth deferred (see [deferred.md](deferred.md)). |
| File uploads (avatars, buzz images) | **Direct S3-compatible upload** | The deployment target (Kubernetes) makes filesystem state painful; defer to object storage from the start. |
| Background jobs | **`bullmq` + Redis** | For: image thumbnail generation, GitHub README sync, scheduled tag rollups. |
| Logging | **pino** (Fastify default) | Pretty in dev, JSON in prod. |
| Email | **Resend** (transactional) | For password resets, "help wanted" notifications. Service account, not per-user OAuth. |

### What we deliberately *don't* use

- **Next.js / SSR** — SPA is enough for v1; SSR can be added later if SEO becomes a measurable problem
- **GraphQL** — REST + zod-typed JSON is sufficient for the surface area
- **A separate admin app** — admin actions are gated routes within the same app
- **Multi-tenancy / multi-brigade extensibility** — laddr's "extend" pattern (hologit overlays) is dropped; this is a single-tenant codeforphilly.org app. If another brigade wants the codebase later, they fork.

## Repository layout

```
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
│       │   ├── plugins/      # env, db, auth, cors
│       │   ├── routes/       # One file per endpoint group; mirrors specs/api/
│       │   ├── services/     # Business logic (ProjectService, TagService, etc.)
│       │   ├── jobs/         # Background workers
│       │   ├── app.ts
│       │   └── index.ts
│       └── drizzle/          # Schema + migrations
├── packages/
│   └── shared/               # Zod schemas + TypeScript types shared web↔api
│       └── src/
├── specs/                    # ← source of truth
├── .claude/
│   ├── agents/               # spec-drift-auditor
│   └── commands/             # /audit-spec-drift
├── CLAUDE.md
├── package.json              # npm workspaces
├── tsconfig.base.json
└── .tool-versions            # asdf-managed node version
```

### Why monorepo

The web and api share zod schemas for every request/response shape. Putting them in `packages/shared` means the frontend gets compile-time type safety against the backend without a separate codegen step or OpenAPI roundtrip. Drizzle schema types can also be re-exported from `packages/shared` so the frontend uses the same field names as the database.

### Workspace tool

`npm` workspaces. Not bun, not pnpm — keeps the deploy story boring and matches the user's preference for `npm` on non-bun JS projects.

## Conventions

- **TypeScript everywhere.** No `.js` files in `src/`. `strict: true` in `tsconfig.base.json`.
- **Field naming** — camelCase in TypeScript; snake_case in Postgres columns. Drizzle maps between them.
- **IDs** — UUIDv7 for all primary keys. Stable, sortable, k-sortable-by-creation, no leaked count. Migration from laddr's auto-increment IDs is via a `legacy_id` column on each table.
- **Slugs** — every user-facing entity has a `slug` (replaces laddr's `Handle`). Slugs are URL-safe, lowercase, hyphen-separated, unique within their type. See [behaviors/slug-handles.md](behaviors/slug-handles.md).
- **Timestamps** — `createdAt`, `updatedAt` on every table. UTC. Stored as `timestamptz`.
- **Soft deletes** — only on `projects` and `people` (laddr precedent: project deletions also tombstone via VersionedRecord). Use `deletedAt timestamptz null`.
- **Error envelope** — see [api/conventions.md](api/conventions.md).

## Build, dev, deploy

### Local development

```bash
# from repo root
npm install
npm run dev              # runs api + web concurrently with watch
```

Web dev server proxies `/api/*` to the api on `localhost:3001`. Both rebuild on file changes (`tsx watch` for api, Vite HMR for web).

### Build

```bash
npm run build            # builds web → apps/web/dist, api → apps/api/dist
npm run type-check       # tsc --noEmit across workspaces
```

### Deploy

A single Docker image bundles the built API and serves the static `apps/web/dist` from the same Fastify instance via `@fastify/static`. This keeps deploy simple (one container, one ingress) and aligns with the existing Helm chart layout from `codeforphilly.org`'s `.holo/branches/helm-chart`.

The k8s manifests live in `deploy/` and follow the same Helm conventions; cluster targeting and secret management are unchanged from the legacy stack (see `docs/operations/migrate-to-k8s.md` in the laddr repo for context).

## Data migration

A one-shot migration script (`apps/api/scripts/import-laddr.ts`) reads from a mysqldump of the production laddr database and writes to the new Postgres schema. Each row gets a `legacy_id` column populated with the laddr `ID`, so URLs like `/projects/squadquest` resolve in both systems against the same slug.

The migration is not run in production until the spec for each migrated table is accepted. It's a tool for cutover, not a long-term integration.

## Authorization model

Three levels, matching laddr's `Person.AccountLevel`:

| Level | Who | Can |
|-------|-----|-----|
| **Anonymous** | Not signed in | Browse public content; view profiles, projects, updates, buzz |
| **User** | Signed-in member | Update own profile; post project updates on projects they're a member of; post buzz to any project; create new projects (auto-becomes maintainer) |
| **Staff** | Trusted contributor | Edit any project; manage project members; promote help-wanted to highlighted; moderate content |
| **Administrator** | Org leadership | All Staff powers + manage users + irreversible deletes + impersonate |

Authorization rules per endpoint and screen live in the respective spec files, with the cross-cutting policy in [behaviors/authorization.md](behaviors/authorization.md).

## Performance budgets

- **Projects index** — first contentful paint < 1.5s, time-to-interactive < 3s on cable broadband
- **API p95** — < 200ms for read endpoints, < 500ms for write endpoints
- **Bundle size** — initial JS < 250 KB gzipped; lazy-load admin and edit views

These are targets, not gates. Violations get a ticket; they don't block release unless they're 2x off.
