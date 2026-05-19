---
status: done
depends: []
specs:
  - specs/behaviors/storage.md
issues: [65]
pr: 70
---

# Plan: Hot-reload webhook for the public data branch

## Scope

Add `POST /api/_internal/reload-data` — an authenticated webhook that pulls the latest commit on the configured `CFP_DATA_BRANCH` and atomically rebuilds the in-memory state, so a push to `published` propagates to the running pod without a restart.

Triggered by a GitHub Actions workflow living on the `codeforphilly-data` repo (delivered as PR-body YAML, not committed here).

Out of scope: HMAC payload signing, multi-pod fanout, push-side schema validation in the GH Action.

## Implements

- [specs/behaviors/storage.md](../specs/behaviors/storage.md) — new "Hot reload" subsection covering the endpoint's existence + behavior.

## Approach

1. **Env var.** Add `CFP_DATA_RELOAD_SECRET` to `apps/api/src/env.ts` + `envJsonSchema` (optional, min 32 chars). When unset, the route exists but responds 503.
2. **Helper.** New `apps/api/src/store/memory/reload.ts` exports `reloadInMemoryStateAndFts(fastify)` — builds a fresh `InMemoryState` first, then mutates the live state's Maps in a tight synchronous block. Failure during the build leaves the running state untouched; failure during the mutate block is loud and the pod is in undefined state (caller returns 5xx). Adds a `reload(state)` method to `FtsEngine` that drops every FTS5 table's rows and re-inserts.
3. **Route.** New `apps/api/src/routes/internal.ts` registers `POST /api/_internal/reload-data`:
   - `schema: { hide: true }` so it's omitted from the public OpenAPI doc.
   - Bearer-token auth using `crypto.timingSafeEqual` (length-checked first); generic 401 message.
   - 503 if `CFP_DATA_RELOAD_SECRET` is unset.
   - Body `{ branch?: string, commitHash?: string }` — both optional, validated via Fastify schema.
   - **Cheap pre-check**: if `commitHash` given and `git merge-base --is-ancestor commitHash HEAD` exits 0 → 200 noChanges, no lock acquired.
   - Otherwise calls `fastify.reconcileDataRepo({ branch })`. If outcome is `'in-sync'` → 200 noChanges with the outcome. Anything else → rebuild via the helper and return 200 with `rebuilt: true`.
4. **Wire-up.** Register `internalRoutes` in `apps/api/src/app.ts` alongside other routes.
5. **Tests.** `apps/api/tests/internal-reload.test.ts` covers 401 (missing/wrong token), 503 (unset secret), 200 noChanges via pre-check, 200 in-sync, 200 fast-forward + rebuilt with the new record visible via a service call.
6. **Docs.** Add `CFP_DATA_RELOAD_SECRET` row to the deploy.md env table. New "Hot-reload webhook" section in runbook.md.
7. **Workflow YAML.** Not committed to this repo; delivered in the PR body for the operator to drop into `codeforphilly-data`.

## Validation

- [x] `npm run -w apps/api type-check` passes
- [x] `npm run -w apps/api test` — full suite green, including the new `internal-reload.test.ts`
- [x] `POST /api/_internal/reload-data` without Authorization → 401 generic message
- [x] Wrong bearer token → 401 (same shape; constant-time comparison verified by code review)
- [x] Unset `CFP_DATA_RELOAD_SECRET` → 503 "hot-reload not configured"
- [x] Body `{ commitHash: <ancestor-of-HEAD> }` → 200 noChanges with no rebuild
- [x] Empty body, no remote changes → 200 noChanges with `outcome: 'in-sync'`
- [x] Empty body, remote ahead of local → 200 with `outcome: 'fast-forwarded'`, `rebuilt: true`, and a service call sees the new record
- [x] Half-built rebuild does not corrupt running state (validated by reading reload.ts — fresh state is built fully before live state mutates)

## Risks / unknowns

- **In-place mutation of `fastify.inMemoryState`** — services hold references to the live state object. We must mutate Map contents in place; replacing the object would orphan the services. Mitigation: helper clears + re-populates Maps on the existing object.
- **FTS reload mid-failure** — if the DELETE succeeds but inserts throw, the running FTS index is in a partial state. Mitigation: load fresh state to a local variable first; if FTS reload throws, log loudly and the route returns 500 so the operator can manually restart the pod.
- **Push-daemon self-trigger** — the API pushes its own commits, the workflow fires, the webhook arrives for a commit the pod already has. The cheap pre-check handles this without a fetch.

## Notes

- **Gitsheets caches dataTree per Sheet at openStore time.** A `git merge --ff-only` updates the working tree but the already-open `Store`'s Sheet snapshots still bind the pre-merge tree, so `queryAll()` keeps returning the old records. The reload helper re-opens the public store and replaces it via a new `Store.swapPublic(newPublic)` method. Anything reading via the cached Sheets (the revocation sweeper, anything future-facing that reaches for `fastify.store.public.<sheet>`) now picks up the new tree. Transacts are unaffected — `repo.transact` builds a fresh workspace from the parent commit per call.
- **In-place Map mutation, not pointer replacement.** Services capture the `InMemoryState` object at boot. Replacing it would orphan them. Helper builds a fresh state to a local var, then `clear()` + `set()` every Map on the live object in a tight synchronous block. If `loadInMemoryState` throws, the live state is untouched. If the FTS reload (last step) throws, the in-memory state has already been swapped but the FTS index is in undefined territory — the route logs loudly and returns 500 so the operator knows a pod restart is warranted.
- **503 vs. 401 ordering chosen for probe resistance.** Missing/empty `Authorization` → 401 *before* checking whether the secret is configured. Unauthenticated probes can't tell whether the env var is set; only callers that present *some* bearer token get a 503-vs-401 distinction.
- **`FtsEngine.reload(state)` is a single SQLite transaction.** Drops every FTS5 table's rows, re-inserts. If the inserts throw mid-transaction, SQLite rolls back to the prior contents. The handle and prepared statements are preserved so consumers holding `fastify.fts` keep working.
- **The workflow YAML for the data repo lives in the PR body, not in this repo.** Per the cautions in the task, this PR doesn't touch `.github/workflows/` here. The operator adds the workflow to `codeforphilly-data` and mirrors the secret value between the sealed Secret in the GitOps repo and the data repo's repository (or environment) secret.

## Follow-ups

- Tracked as: operator must add `notify-deployments.yml` to `codeforphilly-data` and provision `CFP_DATA_RELOAD_SECRET` as both a sealed Secret in the GitOps repo and a repo/env secret on `codeforphilly-data`. The PR body contains the workflow YAML + step-by-step.
- Tracked as: production cluster gets the same wiring once it stands up — the workflow YAML's matrix has a placeholder entry for the prod URL.
