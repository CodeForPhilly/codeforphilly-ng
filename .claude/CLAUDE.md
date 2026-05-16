# codeforphilly-rewrite

A modernization of [laddr](https://github.com/CodeForPhilly/laddr) (the platform behind [codeforphilly.org](https://codeforphilly.org)) onto a Fastify + Vite/React + gitsheets stack.

## Spec-driven

**`specs/` is the source of truth.** Before writing or changing code, read the relevant spec; if the spec doesn't cover what you're about to do, update the spec first.

Workflow:

1. Spec change → propose what should be true
2. Reviewer agrees on desired state
3. Implement to match the spec
4. Verify running software matches the spec

Start at [specs/README.md](../specs/README.md). The index of what's where:

- [specs/architecture.md](../specs/architecture.md) — stack, repo layout, deploy
- [specs/data-model.md](../specs/data-model.md) — entities, fields, relationships
- [specs/deferred.md](../specs/deferred.md) — features intentionally out of scope (do NOT silently implement these)
- [specs/api/](../specs/api/) — endpoint contracts (one file per resource group)
- [specs/screens/](../specs/screens/) — one file per route — what the user sees, what they can do
- [specs/behaviors/](../specs/behaviors/) — cross-cutting rules referenced from multiple screens/APIs

## Spec drift auditing

Run `/audit-spec-drift` to launch a comprehensive audit comparing `specs/` against the implementation. Use it before starting major work, after large refactors, and as part of the release checklist.

## Plans

`plans/` is the micro-DAG of work that bridges `specs/` to the running code. If specs describe **state** (what should be true forever), plans describe **motion** (how we get there). Start a feature with a plan; the plan declares its scope, the specs it implements, its dependencies, and concrete validation criteria.

Plans index: [plans/README.md](../plans/README.md). Workflow:

1. **Add a plan** when starting a new chunk of work. `status: planned` + `depends:` set.
2. **Move to `in-progress`** when you start, as the first commit on the branch (`chore(plans): mark <slug> in-progress`). Skippable for tiny plans — going straight to `done` at the end is fine. Multiple plans can be in-progress in parallel across people, but one plan per contributor at a time is the norm.
3. **Move to `done` as the last commit on the branch, before merge.** That commit does the following, all in one shot, with message `chore(plans): mark <slug> done (PR #<n>)`:
   - Frontmatter: `status` → `done`, add `pr: <PR number>` (knowable once `gh pr create` returns)
   - **Validation checklist: flip each `- [ ]` to `- [x]` for criteria you verified.** If a criterion can't be verified at merge time (depends on a downstream plan, needs production deploy, etc.), leave it unchecked and add a one-line note in the Notes section explaining why and where it'll close out. Never silently rewrite a validation criterion to match what you ended up doing — that's a plan amendment in its own earlier commit.
   - **Notes** section: non-actionable carry-forwards — decisions, surprises, gotchas, learnings. Things future-you would want to know.
   - **Follow-ups** section: actionable items that didn't ship with this plan. Each entry is one of:
     - `Issue [#N](link) — short description` — when actionable and not owned by an existing planned-or-in-progress plan, file the issue first (`gh-axi issue create`) and link it
     - `Deferred to [`<other-plan>`](<other-plan>.md) — short description` — when an unstarted (`status: planned`) downstream plan should own the work. **The same closeout commit must also edit that downstream plan to absorb the deferral** — typically a new bullet under Approach and a new criterion under Validation. If the downstream plan is already `in-progress` or `done`, use the Issue shape instead; never modify a plan that's actively being implemented or already frozen.
     - `Tracked as: <free-form pointer>` — for anything else (waiting on community input, vendor response, etc.)
     - `None.` — explicit when there's nothing, so a future reader can see the section was considered, not just absent
   - The plan is frozen after merge — historical record, no further edits
4. **Update `depends:`** as the DAG sharpens — a plan can discover it needs a new prereq mid-stream.
5. **Specs come first.** A plan implements specs that already exist. If you realize specs need to change mid-plan, the spec change is its own PR before the plan continues.
6. **Splitting a plan**: rename and add the new one with `depends:` updated.

A plan's frontmatter:

```yaml
---
status: planned          # planned | in-progress | done | blocked | cancelled
depends: [other-plan-slug]
specs:                   # spec files in THIS repo that this plan implements
  - specs/architecture.md
  - specs/behaviors/storage.md
upstream-specs:          # (optional) specs in OTHER repos this plan consumes
  - gitsheets:specs/behaviors/transactions.md
  - gitsheets:specs/api/errors.md
awaits:                  # (optional) external blockers — releases, decisions, deliveries
  - "JarvusInnovations/gitsheets@v1.0 — Repository / Sheet / openStore API"
issues: [128, 129]       # related GitHub issues (optional)
pr: 42                   # merged PR once done (optional)
---
```

`specs:` is for specs we own — the spec-drift-auditor matches them against implementation. `upstream-specs:` is for specs owned by dependencies (e.g., gitsheets) that this plan consumes; they're informational only and the spec-drift-auditor doesn't check them. Use the `<repo>:<path>` form so it's obvious where to look.

`awaits:` captures external blockers — upstream library releases, vendor deliveries, partner decisions. Each entry is a one-line free-form pointer (URL, `repo@tag`, "vendor X delivery", etc., with a trailing em-dash clause for the *why* so the entry self-explains when grep surfaces it). The three structural fields (`depends:`, `upstream-specs:`, `awaits:`) are **orthogonal axes**, not mutually exclusive categories — the same upstream relationship can carry multiple. The example above is the canonical case: gitsheets appears in `upstream-specs:` (the specs we'll implement against) *and* in `awaits:` (the v1.0 release we're waiting for). Different axes of the same upstream. `awaits:` is also independent of `status:`: a `planned` plan can carry `awaits:` from day one; a `blocked` plan should always have `awaits:` populated to say why (the scripts warn if `status: blocked` is set with neither `awaits:` nor unfinished `depends:`). Resolution is just deleting the entry when the awaited thing happens. `plans-next` never lists a plan with non-empty `awaits:` under "Ready" — it surfaces in an "Awaiting external" section. Full convention: [`agent-skills/skills/specops/references/plans-protocol.md`](https://github.com/JarvusInnovations/agent-skills/blob/main/skills/specops/references/plans-protocol.md#external-blockers).

A plan's body follows the template in [plans/README.md](../plans/README.md): Scope, Implements, Approach, Validation, Risks/unknowns, Notes, Follow-ups. The Validation section is the load-bearing part — it converts "in-progress" to "done."

**Plans are not specs.** They're project-management artifacts. Plans rot fast — once a plan is `done`, it's a historical record; don't keep editing it. The `spec-drift-auditor` reads `specs/`, not `plans/`.

## Stack

- **Backend** — Fastify 5.x + TypeScript. Single replica, in-process write mutex.
- **Public storage** — [gitsheets](https://github.com/JarvusInnovations/gitsheets) (TOML records in a git repo). Public-by-design — civic transparency. No persistent OLTP. See [specs/behaviors/storage.md](../specs/behaviors/storage.md).
- **Private storage** — S3-compatible bucket holding two `.jsonl` files (private profiles + legacy password hashes). Boot-load + in-memory; PUT on mutation. See [specs/behaviors/private-storage.md](../specs/behaviors/private-storage.md).
- **Schemas** — Zod in `packages/shared`, consumed by both web and api, validating records in both stores.
- **Full-text search** — in-memory SQLite FTS5 (or MiniSearch fallback), rebuilt at boot from gitsheets state.
- **Auth** — GitHub OAuth as the sole primary identity provider; stateless JWT sessions. We are also the SAML IdP for codeforphilly.slack.com. See [specs/api/auth.md](../specs/api/auth.md), [specs/api/saml.md](../specs/api/saml.md).
- **Frontend** — Vite + React 19 + shadcn/ui + Tailwind v4 + React Router v7.

See [specs/architecture.md](../specs/architecture.md) for the full stack rationale.

Per the user's global rules: `npm` workspaces (not bun), `asdf` manages the Node version, commit lockfiles.

### Three persistence surfaces

1. **Public gitsheets data repo** (`codeforphilly-data` — pushed publicly) — projects, members' public fields, tags, etc.
2. **Private bucket** — emails, newsletter prefs, legacy password hashes during migration. Production-only; devs use a local filesystem backend with seeded fakes.
3. **Public snapshot** (`codeforphilly-data-snapshot`) — anonymized, contributor-cloneable copy of the public data. PII-free by construction.

**Real production private data never lands on a dev machine** — see [specs/behaviors/private-storage.md](../specs/behaviors/private-storage.md).

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
- Use the response envelope from [specs/api/conventions.md](../specs/api/conventions.md) for every endpoint.
- Markdown is rendered server-side. Clients never run a markdown library on user content. See [specs/behaviors/markdown-rendering.md](../specs/behaviors/markdown-rendering.md).
- Mutations go through the in-process write mutex documented in [specs/behaviors/storage.md](../specs/behaviors/storage.md). Don't write to the data repo from anywhere else.

## Source control

- **Conventional commits** — `type(scope): description` (e.g., `feat(api): add help-wanted endpoints`, `fix(web): correct stage badge color`, `docs(specs): clarify slug rules`).
- **Logical sets per commit** — group related changes together; commit often as soon as each set is ready. When multiple uncommitted change-sets exist, commit them separately in a logical order rather than mashing together.
- **Always `git status` before staging.** Stage specific files or directories — never `git add -A` or `git add .` (which can sweep in `.env`, credentials, large binaries, or unrelated work).
- **Generated changes commit first.** When a command modifies files (`npm install`, `npx shadcn@latest add ...`), commit those generated changes in a dedicated commit with the exact command in the body. Then make manual edits in a separate follow-up commit.
- **Don't commit suspected secrets** — `.env`, anything in `*.local.*`, credentials, private keys. Warn explicitly if asked to commit one of these.

## Migration context

We are migrating from a MySQL-backed PHP/Emergence app to a gitsheets-backed Node app. Every user-facing URL stays the same. See:

- [specs/behaviors/slug-handles.md](../specs/behaviors/slug-handles.md) — slug format and uniqueness
- [specs/behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md) — `legacyId` column and URL redirects
- The one-shot importer lives at `apps/api/scripts/import-laddr.ts` (not yet implemented)

## When in doubt

Pick the spec that mentions what you're working on. If multiple specs apply (e.g., a project detail screen calls multiple endpoints), read each. If you can't find a spec, the answer is to write one — not to make up behavior.
