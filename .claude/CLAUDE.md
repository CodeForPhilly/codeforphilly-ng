# codeforphilly-rewrite

A modernization of [laddr](https://github.com/CodeForPhilly/laddr) (the platform behind [codeforphilly.org](https://codeforphilly.org)) onto a Fastify + Vite/React + gitsheets stack.

## Skills available in this repo

These auto-trigger by topic — you don't load them manually. Mentioned here so you know what's already covered and don't duplicate.

| Skill | Triggers on | What it covers |
|---|---|---|
| [`specops`](./skills/specops/SKILL.md) | `specs/`, `plans/`, "spec", "closeout commit", new features | Spec-driven workflow (specs are source of truth), plans-as-micro-DAG protocol, closeout commit ritual, follow-ups taxonomy, spec-drift auditor |
| [`backend-fastify`](./skills/backend-fastify/SKILL.md) | New routes, services, plugins, env vars | Fastify 5 patterns, plugin ordering, `@fastify/env` validation, error handling |
| [`frontend-shadcn`](./skills/frontend-shadcn/SKILL.md) | New screens, components, routing, styling | Vite + React 19 + shadcn/ui + Tailwind v4 + React Router v7 patterns |

Skills are version-pinned via `skills-lock.json`. To update: `agent-skills` CLI.

### Working laterally on the data repo

When you `cd` into a clone of [`CodeForPhilly/codeforphilly-data`](https://github.com/CodeForPhilly/codeforphilly-data) (typically a sibling — see [Local setup](#local-setup) below), **read its `.claude/CLAUDE.md` first** — that repo has its own conventions and ships a `gitsheets` skill at `.claude/skills/gitsheets/` covering library use, transactions, path templates, indices. Don't write TOML records or shell out to git there by hand.

## Three repos in this project

```
codeforphilly-ng (this repo) ─── Fastify API + Vite SPA + Docker image
                              │
                              │ runtime reads/writes via gitsheets
                              ▼
codeforphilly-data            ─── Public data store. Branches:
                              │     empty — .gitsheets/ configs + tooling only
                              │     fixture — small hand-curated test data
                              │     legacy-import — full snapshot from laddr
                              │     published — runtime-served (fixture/legacy
                              │                 merge target). Hot-reload webhook
                              │                 fires on push.
                              │
cfp-sandbox-cluster           ─── GitOps repo (hologit-projected) that pulls
                              │     this repo's `deploy/kustomize/` upstream
                              │     and applies it via Kustomize. See
                              │     `docs/operations/deploy.md`.
```

Operator docs in [`docs/operations/`](../docs/operations/): `deploy.md` for the cluster topology, `sandbox-deploy.md` for the manual procedure, `runbook.md` for incident response (including the hot-reload webhook).

## Stack

- **Backend** — Fastify 5.x + TypeScript. Single replica, in-process write mutex.
- **Public storage** — [gitsheets](https://github.com/JarvusInnovations/gitsheets) (TOML records in a git repo). Public-by-design — civic transparency. No persistent OLTP. See [specs/behaviors/storage.md](../specs/behaviors/storage.md).
- **Private storage** — S3-compatible bucket holding `.jsonl` files (private profiles + legacy password hashes). Boot-load + in-memory; PUT on mutation. See [specs/behaviors/private-storage.md](../specs/behaviors/private-storage.md). Real production private data never lands on a dev machine.
- **Schemas** — Zod in `packages/shared`, consumed by both web and api, validating records in both stores.
- **Full-text search** — in-memory SQLite FTS5 (or MiniSearch fallback), rebuilt at boot from gitsheets state.
- **Auth** — GitHub OAuth as the sole primary identity provider; stateless JWT sessions. We're also the SAML IdP for codeforphilly.slack.com. See [specs/api/auth.md](../specs/api/auth.md), [specs/api/saml.md](../specs/api/saml.md).
- **Frontend** — Vite + React 19 + shadcn/ui + Tailwind v4 + React Router v7.

Full rationale: [specs/architecture.md](../specs/architecture.md).

### Runtime data flow

The API holds the full public dataset in memory at boot. Writes go through a single in-process mutex, transact into gitsheets, and `stateApply` into the in-memory state synchronously — reads and writes share one source of truth.

Two background concerns keep that store in sync with the world:

- **Push daemon** — `apps/api/src/plugins/push-daemon.ts`. Pushes new commits up to `origin/<CFP_DATA_BRANCH>` continuously with retry/backoff.
- **Reconcile + hot reload** — `apps/api/src/store/reconcile.ts` + `apps/api/src/plugins/reconcile.ts`. Runs at boot to fast-forward / rebase / escape-hatch the local clone against origin. `POST /api/_internal/reload-data` (the hot-reload webhook, called by a GH Action on push to `published`) runs the same path mid-life and atomically rebuilds the in-memory state in place. See [specs/behaviors/storage.md#hot-reload](../specs/behaviors/storage.md#hot-reload).

## Project conventions

- TypeScript everywhere. `strict: true`. No `.js` in `src/`.
- Field names: `camelCase` in TS and in TOML records. No casing translation.
- IDs: UUIDv7. **Slugs** (not IDs) in user-facing URLs.
- Timestamps: ISO 8601 UTC strings (e.g., `"2026-05-15T18:42:00Z"`) — in requests, responses, and on disk.
- Every endpoint uses the response envelope from [specs/api/conventions.md](../specs/api/conventions.md).
- Markdown is rendered server-side. Clients never run a markdown library on user content. See [specs/behaviors/markdown-rendering.md](../specs/behaviors/markdown-rendering.md).
- Mutations go through the in-process write mutex in [specs/behaviors/storage.md](../specs/behaviors/storage.md). Don't write to the data repo from anywhere else.

## Tooling

- **`gh-axi`** for GitHub operations (issues, PRs, runs, releases). Wraps `gh` with terse output. Don't use bare `gh`.
- **`asdf`** for tool versions. Never edit `.tool-versions` directly — use `asdf set nodejs latest:22`, then `asdf install`.
- **`jq`** for JSON in shell pipelines. No inline Python/Node/Ruby for JSON.
- **`npm`** (workspaces, not bun, not pnpm). Never hand-edit `package.json` / `package-lock.json` — use `npm install <pkg>`, `npm install <pkg>@<version>`, `npm uninstall <pkg>`. Commit lockfiles.

### CI

`.github/workflows/ci.yml` runs `npm ci` → builds `@cfp/shared` → type-check → lint → test → build. The pre-emptive `@cfp/shared` build matters because the workspace's exports map points at `dist/` (not `src/`); other workspaces' type-check can't resolve `@cfp/shared/schemas` until shared is compiled.

## Local setup

1. `asdf install` — picks up Node from `.tool-versions`
2. Clone the data repo as a sibling: `git clone git@github.com:CodeForPhilly/codeforphilly-data.git ../codeforphilly-data` (checkout `fixture` for a small seed, or `published` for the full laddr import)
3. `cp .env.example .env` and edit — point `CFP_DATA_REPO_PATH` at your sibling clone (absolute path recommended; relative paths resolve from `apps/api/`, not repo root)
4. `npm install`
5. `npm run dev` — api + web concurrently

```bash
npm install                 # install all workspaces
npm run dev                 # api + web concurrently
npm run build               # build all workspaces
npm run type-check          # tsc --noEmit across workspaces
npm run lint                # eslint
npm run -w apps/api dev     # api only
npm run -w apps/web dev     # web only
```

## Source control

- **Conventional commits**: `type(scope): description`. Subject in imperative voice, ≤72 chars. Body wraps at ~72 and explains *why* — readers can already see *what* from the diff.
- **Co-Authored-By trailer** on every commit when working with an agent: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Logical sets per commit** — group related changes; commit often. When multiple uncommitted change-sets exist, separate them.
- **Always `git status` before staging.** Stage specific files. Never `git add -A` or `git add .` — they sweep in `.env`, credentials, large binaries, or unrelated work.
- **Generated changes commit first.** `npm install`, `npx shadcn@latest add ...`, etc. — separate commit with the exact command in the body. Manual edits in a follow-up commit.
- **Don't commit secrets** — `.env`, `*.local.*`, credentials, private keys. Warn explicitly if asked.
- **Merging PRs**: rebase locally onto `main` first (preserves atomic commit history), then `gh pr merge --merge` (never `--rebase` or `--squash` — merge commits group multi-commit PRs in `git log --first-parent`).

## Migration context

We're migrating from a MySQL-backed PHP/Emergence app to gitsheets-backed Node. Every user-facing URL stays the same. Key specs:

- [specs/behaviors/slug-handles.md](../specs/behaviors/slug-handles.md) — slug format and uniqueness
- [specs/behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md) — `legacyId` field + URL redirects

The importer lives at `apps/api/scripts/import-laddr.ts` and writes snapshot commits to the `legacy-import` branch of the data repo. It's re-runnable; each run fully replaces the previous tree.

## When in doubt

Read the spec that mentions what you're working on. If multiple specs apply (e.g., a project detail screen calls multiple endpoints), read each. **If you can't find a spec, the answer is to write one — not to make up behavior.**
