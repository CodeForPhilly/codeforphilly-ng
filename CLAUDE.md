# codeforphilly-rewrite

A modernization of [laddr](https://github.com/CodeForPhilly/laddr) (the platform behind [codeforphilly.org](https://codeforphilly.org)) onto a Fastify + Vite/React + gitsheets stack.

## Spec-driven

**`specs/` is the source of truth.** Before writing or changing code, read the relevant spec; if the spec doesn't cover what you're about to do, update the spec first.

Workflow:

1. Spec change → propose what should be true
2. Reviewer agrees on desired state
3. Implement to match the spec
4. Verify running software matches the spec

Start at [specs/README.md](specs/README.md). The index of what's where:

- [specs/architecture.md](specs/architecture.md) — stack, repo layout, deploy
- [specs/data-model.md](specs/data-model.md) — entities, fields, relationships
- [specs/deferred.md](specs/deferred.md) — features intentionally out of scope (do NOT silently implement these)
- [specs/api/](specs/api/) — endpoint contracts (one file per resource group)
- [specs/screens/](specs/screens/) — one file per route — what the user sees, what they can do
- [specs/behaviors/](specs/behaviors/) — cross-cutting rules referenced from multiple screens/APIs

## Spec drift auditing

Run `/audit-spec-drift` to launch a comprehensive audit comparing `specs/` against the implementation. Use it before starting major work, after large refactors, and as part of the release checklist.

## Stack

- **Backend** — Fastify 5.x + TypeScript. Single replica, in-process write mutex.
- **Storage** — [gitsheets](https://github.com/JarvusInnovations/gitsheets) (TOML records in a git repo). No persistent OLTP. See [specs/behaviors/storage.md](specs/behaviors/storage.md).
- **Schemas** — Zod in `packages/shared`, consumed by both web and api.
- **Full-text search** — in-memory SQLite FTS5 (or MiniSearch fallback), rebuilt at boot from gitsheets state.
- **Frontend** — Vite + React 19 + shadcn/ui + Tailwind v4 + React Router v7.

See [specs/architecture.md](specs/architecture.md) for the full stack rationale.

Per the user's global rules: `npm` workspaces (not bun), `asdf` manages the Node version, commit lockfiles.

### Two repos

The code lives here. The data lives in a separate git repo (`codeforphilly-data`, private) referenced via `CFP_DATA_REPO_PATH`. Contributors clone a scrubbed snapshot (`codeforphilly-data-snapshot`, public) for local dev — no database to install.

## Tooling

- **`gh-axi`** for all GitHub operations (issues, PRs, runs, releases, repos, labels, search). It wraps `gh` with terse output and contextual suggestions. Don't use bare `gh`.
- **GitHub Actions** — when authoring or modifying a workflow, run `gh-axi repo view <owner>/<repo>` on each action's repo to confirm the latest recommended version and usage before writing the workflow.
- **`asdf`** manages tool versions. Never edit `.tool-versions` directly — use `asdf set nodejs latest:22` (or the equivalent) and then `asdf install`. If a tool isn't available despite being in `.tool-versions`, run `asdf install`.
- **`jq`** for processing JSON in any shell pipeline. Don't write inline Python/Node/Ruby to filter JSON.
- **`npm`** for packages. Never hand-edit `package.json` or `package-lock.json` — use `npm install <pkg>`, `npm install <pkg>@<version>`, `npm uninstall <pkg>`, `npm run <script>` so versions and the lockfile stay coherent. Always commit `package-lock.json` for reproducible builds.

## Commands (once scaffolded)

```bash
npm install                 # install all workspaces
npm run dev                 # api + web concurrently with watch
npm run build               # build all workspaces
npm run type-check          # tsc --noEmit across workspaces
npm run lint                # eslint
```

Per-workspace:

```bash
npm run -w apps/api dev
npm run -w apps/web dev
```

## Authorship conventions

- TypeScript everywhere. `strict: true`. No `.js` in `src/`.
- Field names: `camelCase` in TS and in TOML records. No casing translation.
- IDs: UUIDv7. Slugs (not IDs) in user-facing URLs.
- Timestamps: ISO 8601 UTC strings (e.g., `"2026-05-15T18:42:00Z"`) — in requests, responses, and on disk.
- Use the response envelope from [specs/api/conventions.md](specs/api/conventions.md) for every endpoint.
- Markdown is rendered server-side. Clients never run a markdown library on user content. See [specs/behaviors/markdown-rendering.md](specs/behaviors/markdown-rendering.md).
- Mutations go through the in-process write mutex documented in [specs/behaviors/storage.md](specs/behaviors/storage.md). Don't write to the data repo from anywhere else.

## Source control

- **Conventional commits** — `type(scope): description` (e.g., `feat(api): add help-wanted endpoints`, `fix(web): correct stage badge color`, `docs(specs): clarify slug rules`).
- **Logical sets per commit** — group related changes together; commit often as soon as each set is ready. When multiple uncommitted change-sets exist, commit them separately in a logical order rather than mashing together.
- **Always `git status` before staging.** Stage specific files or directories — never `git add -A` or `git add .` (which can sweep in `.env`, credentials, large binaries, or unrelated work).
- **Generated changes commit first.** When a command modifies files (`npm install`, `npx shadcn@latest add ...`), commit those generated changes in a dedicated commit with the exact command in the body. Then make manual edits in a separate follow-up commit.
- **Don't commit suspected secrets** — `.env`, anything in `*.local.*`, credentials, private keys. Warn explicitly if asked to commit one of these.

## Migration context

We are migrating from a MySQL-backed PHP/Emergence app to a gitsheets-backed Node app. Every user-facing URL stays the same. See:

- [specs/behaviors/slug-handles.md](specs/behaviors/slug-handles.md) — slug format and uniqueness
- [specs/behaviors/legacy-id-mapping.md](specs/behaviors/legacy-id-mapping.md) — `legacyId` column and URL redirects
- The one-shot importer lives at `apps/api/scripts/import-laddr.ts` (not yet implemented)

## When in doubt

Pick the spec that mentions what you're working on. If multiple specs apply (e.g., a project detail screen calls multiple endpoints), read each. If you can't find a spec, the answer is to write one — not to make up behavior.
