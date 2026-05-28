---
status: done
depends: []
specs:
  - specs/behaviors/storage.md
issues: [85]
pr: 86
---

# Plan: Eliminate the working tree — bare-clone the data repo

## Scope

The pod has been carrying a working tree it never reads. gitsheets operates on git tree objects via hologit; the checked-out files on disk are a redundant on-disk copy of records that already exist as git blobs. Worse, hologit's default `getWorkspace()` path (when `workTree` is non-null) **hashes the entire working tree on every workspace construction** — active CPU we don't need to spend.

Switching to a bare clone removes all of this: smaller disk footprint, faster boot, faster hot-reloads, no PVC dependency (so no PVC Multi-Attach errors during node failover, and runbook recovery shrinks from "delete PVC, restart, re-clone" to just "restart").

Closes [#85](https://github.com/CodeForPhilly/codeforphilly-ng/issues/85).

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md) — new invariant: the API operates on a **bare** git clone. No working tree. Reconcile + transact + push all happen via plumbing on the object DB.

## Approach

### 1. Spec update first

Add a new sub-section to `specs/behaviors/storage.md` (probably after "Repositories") declaring the bare-clone invariant. Cross-link from the deploy + runbook docs.

### 2. `openPublicStore` — drop `workTree`, bare-only

In `apps/api/src/store/public.ts`:

```diff
-const repo = await openRepo({ gitDir: `${repoPath}/.git`, workTree: repoPath });
+const repo = await openRepo({ gitDir: repoPath });
```

`repoPath` is the bare gitdir (no `.git` subdirectory). Omitting `workTree` causes hologit's `getWorkspace()` to take the `createWorkspaceFromRef(this.ref)` branch — i.e. resolve from HEAD ref, not from hashing the working tree. Confirmed via `node_modules/hologit/lib/Repo.js:86-97`.

**Single mode — bare everywhere.** The app uses a bare clone whether the runtime is the sandbox pod or a local dev machine. Mixed-mode (bare in prod, non-bare in dev) is what got us into the staleness footgun in the first place: API mutations advance HEAD via gitsheets transact, but a parallel working tree drifts. Keeping prod and dev on the same shape — bare — keeps gitsheets' tree-object view of the world coherent.

### 3. Entrypoint — `git clone --bare`

In `deploy/docker/entrypoint.sh`:

- Detect first-boot via `[ ! -d "$CFP_DATA_REPO_PATH/objects" ]` (the marker for a bare repo) instead of `[ ! -d "$CFP_DATA_REPO_PATH/.git" ]`.
- Clone with `git clone --bare "$CFP_DATA_REMOTE" "$CFP_DATA_REPO_PATH"`.
- Pseudonymous identity config stays (`git config --global user.name/.email` — the `--global` flag means it's irrelevant to the bare/non-bare distinction).
- `git config --global safe.directory` stays.
- The remote-URL refresh logic stays — `git -C "$CFP_DATA_REPO_PATH" remote set-url origin "$CFP_DATA_REMOTE"` works bare-mode.

### 4. Reconcile rewrite — three commands swapped

In `apps/api/src/store/reconcile.ts`:

| Today | Bare equivalent |
|---|---|
| `git merge --ff-only <remoteRef>` (line 207) | `git update-ref refs/heads/$branch <remote-tip> $local-tip` |
| `git rebase <remoteRef>` (line 248) | Per-commit replay via `git merge-tree --write-tree` + `git commit-tree` (see below) |
| `git reset --hard <remoteRef>` (line 305, escape hatch) | `git update-ref refs/heads/$branch <remote-tip>` |

The rebase replay loop:

```
1. mergeBase = git merge-base HEAD origin/<branch>
2. localCommits = git rev-list --reverse mergeBase..HEAD  // oldest first
3. newTip = origin/<branch>'s commit hash
4. for each commit C in localCommits:
     parent = C^
     mergeResult = git merge-tree --write-tree --merge-base=parent newTip C
       (exit 0: writes the merged tree hash to stdout)
       (exit 1: conflicts — escape-hatch)
     newCommitHash = git commit-tree <mergeResult> -p newTip \
                       (carry C's author + committer + dates + message)
     newTip = newCommitHash
5. git update-ref refs/heads/<branch> newTip <localTip>
```

Properties preserved from today's `git rebase`:

- Linear history with local commits **on top of** remote commits (no merge bubbles).
- Local commits' messages + author/committer/dates carry forward to the replayed commits.
- A conflict anywhere in the chain aborts the whole replay (same as `git rebase` failing) and the escape-hatch fires.

Properties dropped (acceptable):

- No interactive rebase / conflict-edit shell. Today's reconcile doesn't do that either — it just escapes on first conflict.

### 5. Kustomize — drop the PVC

`deploy/kustomize/base/pvc.yaml` → delete.

`deploy/kustomize/base/deployment.yaml` — swap the PVC volume mount for `emptyDir`:

```yaml
volumes:
  - name: data-repo
    emptyDir: {}
```

Re-clone on every pod boot is fine on a small repo (objects-only, ~50 MB or so). Validate boot time stays under the existing readiness deadline; if not, fall back to a `kustomize`-level option for an `emptyDir` with `sizeLimit` bumped, but cloning should be well under 60 s.

### 6. Docs + spec

- `specs/behaviors/storage.md` — bare-clone invariant section (step 1 above).
- `docs/operations/deploy.md` — boot sequence: "clone bare, no checkout"; drop the PVC env table entry; drop the `safe.directory` note (still needed for the bare gitdir but the wording shifts).
- `docs/operations/runbook.md` — drop the "delete PVC, restart" recovery procedure under "API won't boot"; recovery is now just a pod restart.
- `.claude/CLAUDE.md` Local setup section — clarify that local dev clones are **non-bare** (so contributors can browse), but the running app is bare. Two paths via the same code (`workTree` parameter optional).

### 7. Local-dev workflow

Local dev mirrors prod: the sibling clone of `codeforphilly-data` is **also bare**. Contributors who want a working tree to browse / hand-edit records clone again *from the bare local* into a second directory and push/pull there.

```bash
# The clone the app uses (matches production shape)
git clone --bare git@github.com:CodeForPhilly/codeforphilly-data.git ../codeforphilly-data

# Optional: a working-tree view of the same data, for browsing/editing
git clone ../codeforphilly-data ../codeforphilly-data-wt
# work in ../codeforphilly-data-wt; push back to ../codeforphilly-data when done
```

Keeping dev and prod on the same bare shape avoids the mixed-mode drift gitsheets struggles with (API-side commits advance HEAD on the bare repo; a co-located working tree would lag and confuse hologit's `hashWorkTree` path).

### 8. Reconcile tests

Add `apps/api/tests/reconcile.test.ts` (or extend an existing file) with the four state-machine cases:

- **Clean ahead** — local has commits, remote has nothing new; expect `outcome: 'pushed-ahead'`, push goes through.
- **Clean behind** — remote has commits, local has nothing new; expect `outcome: 'fast-forwarded'`, refs updated via `git update-ref`.
- **Clean divergent** — both have commits with no overlapping file changes; expect `outcome: 'rebased'`, local commits replayed on top of remote, push fast-forwards.
- **Divergent conflict** — both have commits with conflicting file changes; expect `outcome: 'conflict-escaped'`, `conflicts/<UTC>` branch created + pushed, local refs reset to remote.

Each test sets up two bare clones in `os.tmpdir()` (one as the "pod's local," one as the "origin") wired with a file:// remote URL. The test exercises the reconcile path with realistic transact-style commits, asserts the outcome + final ref state of both clones.

## Validation

- [x] `specs/behaviors/storage.md` declares the bare-clone invariant.
- [x] `openPublicStore` opens a bare clone; non-bare paths fail loudly with a clear error pointing at the bare-only invariant.
- [x] `deploy/docker/entrypoint.sh` bare-clones on first boot; refuses to operate against a stray non-bare clone at `CFP_DATA_REPO_PATH`.
- [x] `reconcile.ts` rebase replay passes unit tests for: clean local-ahead, clean local-behind, clean divergent (replay succeeds), conflicting divergent (escape-hatch fires) — all 7 cases in `data-repo-reconcile.test.ts`.
- [x] All 241 API tests pass; `packages/shared` (53) and `apps/web` (30) pass too.
- [x] `npm run type-check && npm run lint` clean.
- [x] Kustomize manifests render with `emptyDir` mounted; PVC deleted from the base + kustomization.yaml resources list.
- [x] **Sandbox smoke test** — applied via cluster-repo PR [#167](https://github.com/CodeForPhilly/cfp-sandbox-cluster/pull/167) (dropped pvc-data manifest reference + projection); deploy PR [#168](https://github.com/CodeForPhilly/cfp-sandbox-cluster/pull/168) merged 2026-05-28; pod `codeforphilly-7655fb97db-stkk7` boots cleanly on `emptyDir`, `/api/health/ready` returns 200, `/api/projects` serves real records.
- [x] **Hot-reload webhook** still works against the bare runtime — manual `POST /api/_internal/reload-data` returns `{ outcome: 'in-sync', durationMs: 513 }` via the new plumbing reconcile path.
- [x] **Operator `git-pod-uploadpack.sh`** still works — `git fetch pod` from a local data-repo clone returns refs for all branches (the bare clone naturally mirrors more refs than the old single-branch working-tree clone did, a small ergonomic bonus).
- [x] **Boot time** on sandbox: ~10s for `git clone --bare` + ~20s for in-memory state + FTS build = ~32s container-start → readiness 200. Same end-to-end profile as the working-tree path (FTS build dominates either way); the clone itself is fast against GitHub-hosted origin.

## Risks / unknowns

- **First-boot clone time on `emptyDir`** — every pod restart re-clones. Objects-only is ~50 MB today. Acceptable. If the data repo grows past ~500 MB someday, we'd revisit (maybe with a sidecar that does a shared local clone).
- **Reconcile rebase replay edge cases** — empty-commit dropping, sign-off lines, multi-parent commits (none expected on the data repo, but worth a test).
- **`git merge-tree --write-tree`** requires git 2.38+; we're on 2.45+ in the Alpine 3.20 base image. Fine.
- **Dev workflow** — contributors browsing the data repo locally want a working tree. Solution: bare local clone (matches prod) + an optional second clone *from* the bare for a working tree to browse/edit. Same shape everywhere keeps gitsheets coherent (mixed-mode bare-app/working-tree-clone is exactly the drift the bare migration is escaping).

## Notes

Shipped over eight commits on the branch (plan opening + revision + spec + openPublicStore + reconcile rewrite + entrypoint/kustomize + test/scripts sweep + docs).

Surprises:

- **hologit hashes the working tree on every `getWorkspace` call** when one is set (`node_modules/hologit/lib/Repo.js:86-97`). Not just dead weight on disk — active CPU on every gitsheets workspace construction. Going bare eliminates the hash pass entirely.
- **`git merge-tree --write-tree` semantics are a clean fit.** Exit 0 → tree hash on stdout. Exit 1 → conflict info. The per-commit replay loop wraps that with a `RebaseReplayConflictError` throw, which routes to the existing escape-hatch path. Net change to externally-observable state-machine behavior: zero (same six outcomes, same conflict-branch shape, same push semantics).
- **Test scaffolding was where most of the lift was.** `openPublicStore`'s bare-only guard rejected every working-tree-seeding helper. The new `seedRawToml` helper in `tests/helpers/seed-fixtures.ts` centralizes the transient-clone-push pattern; future tests that need to seed raw fixtures use it instead of copying another `git add` block.
- **Local-dev workflow** intentionally stays bare for the app's clone, with an optional second clone-from-the-bare for hand-editing. Mixed mode (bare in prod, working-tree locally) was specifically the drift footgun this work escaped — keeping prod and dev coherent matters here.

## Follow-ups

- **Deploy smoke** — apply the new manifests to the sandbox, verify pod boot + hot-reload + `git-pod-uploadpack.sh` operator helper. *Deferred to operator cadence*; nothing should regress, but the boot-time delta is the one observable worth measuring.
- **Boot-time measurement** — on first deploy with `emptyDir`, capture how long `git clone --bare` takes against the live remote. If it pushes past ~30 s for a small repo, we'd want to know — re-clone overhead is the one cost we accepted in this design. *Deferred to deploy time*.
- **Local-setup onboarding** — `git clone --bare` is now the documented path in CLAUDE.md + storage.md, but if a contributor follows older docs elsewhere (READMEs, third-party blog posts, etc.) they may hit the boot-time bare-only guard. The error message points them at the spec section. *Tracked as*: future polish to "smooth out getting started" (#5).
- **Spec note about hologit `hashWorkTree` cost** — worth a sentence in the storage spec's "Runtime data flow" subsection for posterity. *Deferred* — low urgency since the bare invariant means we never take that path anymore.
