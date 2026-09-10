# Runbook

On-call playbooks for the codeforphilly-ng production service.

> See also: [monitoring.md](monitoring.md) for the alarm signals we *want*
> (none are wired yet), [cutover.md](cutover.md) for cutover-specific
> procedures, [deploy.md](deploy.md) for the GitOps flow.

## Where to point kubectl

| | Cluster repo | Namespace |
| --- | --- | --- |
| Production | `cfp-live-cluster` | `codeforphilly-ng` |
| Sandbox | `cfp-sandbox-cluster` | `codeforphilly-rewrite-sandbox` |

Commands below use `-n codeforphilly-ng`; substitute the sandbox namespace
as needed. The Deployment is `deploy/codeforphilly` in both.

## "API won't boot"

Symptoms: pod CrashLoopBackOff, `kubectl describe pod` shows the container
restarting, no `/api/health` response.

### 1. Read the logs first

```bash
kubectl -n codeforphilly-ng logs deploy/codeforphilly --previous
kubectl -n codeforphilly-ng logs deploy/codeforphilly --tail=200
```

Look for one of the common boot failures:

| Log line excerpt | Cause | Fix |
| ------------------ | ------- | ----- |
| `[entrypoint] ERROR: CFP_DATA_REMOTE is unset` | The Secret containing `CFP_DATA_REMOTE` isn't reaching the pod. | Check `kubectl -n codeforphilly-ng get secret codeforphilly-secrets -o yaml`; verify the SealedSecret in the GitOps repo decrypted successfully (look at the sealed-secrets controller logs). |
| `fatal: could not read Username for 'https://...'` or `Permission denied (publickey)` | Bad/missing data-repo credentials. | Verify the `codeforphilly-data-deploy-key` Secret holds a valid `id_ed25519` whose public key has push access to the data repo. See [secrets.md](secrets.md#data-repo-deploy-key). |
| `Failed to open public gitsheets store` | Bare clone corrupt or missing `.gitsheets/` configs. | Exec into the pod, inspect `/app/data/refs/`, `/app/data/objects/`, and verify `.gitsheets/` exists in HEAD via `git --git-dir=/app/data show HEAD:.gitsheets`. Recovery: restart the pod — `data` is an `emptyDir`, so a fresh pod re-clones from `CFP_DATA_REMOTE` automatically. |
| `Failed to load private store (filesystem)` | The `codeforphilly-private` PVC didn't mount, is read-only, or the `.jsonl` files are malformed. | `kubectl -n codeforphilly-ng describe pod` for volume events; exec in and `ls -la /app/private-storage`. A malformed line points at a bad manual load — see [legacy-credentials-import.md](legacy-credentials-import.md). |
| `environment variable ... is required` | A required env (`CFP_DATA_REPO_PATH`, `STORAGE_BACKEND`, `CFP_JWT_SIGNING_KEY`) is missing. | Manifest regression. Compare against `deploy/kustomize/base/configmap.yaml` + the GitOps repo's SealedSecret. |
| OOMKilled (no log line; `kubectl describe pod` shows it) | In-memory record set too big for `NODE_OPTIONS`/`resources.limits`. Usually an unpruned `published` push. | Check whether the last `published` push skipped the prune step ([spam-detection.md](spam-detection.md)). Re-prune and push; the hot-reload will pick it up once the pod is up. |

### 2. Drop into the pod (if it stays up long enough)

```bash
kubectl -n codeforphilly-ng debug -it deploy/codeforphilly \
  --image=alpine --target=api -- sh
```

From inside:

```bash
# Is the bare data repo really there? Bare gitdir lives at the path root —
# no .git subdir; expect HEAD, config, objects/, refs/ at the top.
ls -la /app/data
git --git-dir=/app/data show HEAD:.gitsheets

# Is the private store there?
ls -la /app/private-storage
wc -l /app/private-storage/*.jsonl

# Are env vars present?
env | grep -E '^(CFP_|STORAGE_|GITHUB_|SAML_|POSTMARK_)' | sort

# Can we reach the data remote?
git ls-remote "$CFP_DATA_REMOTE" 2>&1 | head
```

### 3. Last-resort recovery

If the cluster state is unrecoverable but the data remote is intact:

```bash
# Revert the most recent GitOps deploy (the cluster repo's deploy PR is a
# normal merge commit on `deploys/k8s-manifests`). Use cfp-sandbox-cluster
# for the sandbox.
gh-axi -R CodeForPhilly/cfp-live-cluster pr list --base deploys/k8s-manifests --state merged
git -C ~/Repositories/cfp-live-cluster revert <merge-sha> --mainline 1
git -C ~/Repositories/cfp-live-cluster push origin deploys/k8s-manifests

# Or pin to a previous release: move BOTH
#   .holo/sources/codeforphilly-ng.toml   (ref = "refs/tags/vX.Y.Z")
#   codeforphilly-ng/app/kustomization.yaml (images[].newTag)
# back to the last known-good tag on a branch, PR into main, merge the
# resulting deploy PR.

# Out-of-band hotfix (bypasses GitOps — fix the repo afterward):
kubectl -n codeforphilly-ng set image \
  deploy/codeforphilly codeforphilly=ghcr.io/codeforphilly/codeforphilly-ng:<known-good-tag>
```

The bare data clone lives in an `emptyDir` — re-cloned from the git remote on
every pod boot. Pod restart is the recovery primitive; there's no data PVC to
delete. The `codeforphilly-private` PVC **is** the private store — never
delete it as part of a recovery.

## "Readiness flapping / 503 spikes"

Readiness probe (`/api/health/ready`) returns 503 only when the store
decorators are missing — that only happens during boot. Mid-life flapping
likely means:

- Liveness probe (`/api/health`) failed and k8s is restarting the pod. Look
  at the previous logs.
- Memory pressure → OOMKilled. Check for an unpruned `published` push first
  (see the boot table above); only then bump `resources.limits.memory` /
  `NODE_OPTIONS=--max-old-space-size`.

## "Mutations succeed in UI but don't appear on GitHub"

Push daemon failure. Check logs for git push errors. Common causes:

- Deploy key removed/expired — see [secrets.md](secrets.md#data-repo-deploy-key).
- Remote branch protection rejecting the push.
- Network egress blocked.

The in-memory state and the pod's bare clone continue to accept writes —
it's only the asynchronous mirror to GitHub that's broken. Once fixed, the
daemon pushes the backlog. **Don't restart the pod to "fix" this** until the
backlog has been pushed or fetched out (below): the clone is an `emptyDir`
and unpushed commits die with the pod.

## Hot-reload webhook

The API exposes `POST /api/_internal/reload-data` so that a push to
`CFP_DATA_BRANCH` (`published`) propagates to the running pod without
rolling it. The `codeforphilly-data` repo's
`.github/workflows/notify-deployments.yml` calls this endpoint on every push
to `published`, once per target: sandbox (`next-v2.codeforphilly.org`) and
prod (`next.codeforphilly.org` before cutover; the apex after — the
workflow's prod URL must be switched at cutover, see
[cutover.md](cutover.md#t-0-cutover)).

See [specs/behaviors/storage.md#hot-reload](../../specs/behaviors/storage.md#hot-reload)
for the authoritative contract. Operationally:

- **Configured by** the `CFP_DATA_RELOAD_SECRET` env variable. When
  unset, the endpoint is still registered but returns 503 — the
  workflow's `curl` will exit non-zero and the operator must
  investigate. The value lives in each cluster repo's
  `codeforphilly-ng.secrets/codeforphilly-secrets.yaml` (sealed) and as the
  `CFP_DATA_RELOAD_SECRET` Actions secret on the data repo — all three must
  agree.
- **Public data only.** The webhook reloads the gitsheets state + FTS. It
  does **not** reload the private store; files placed on the PVC need a
  `rollout restart`.
- **Trigger manually** for debugging:

  ```bash
  SECRET=$(kubectl -n codeforphilly-ng get secret \
    codeforphilly-secrets -o jsonpath='{.data.CFP_DATA_RELOAD_SECRET}' | base64 -d)

  curl -sS -X POST https://next.codeforphilly.org/api/_internal/reload-data \
    -H "Authorization: Bearer $SECRET" \
    -H "Content-Type: application/json" \
    -d '{}' | jq
  ```

- **Response shapes** (all wrapped in the success envelope):
  - **No-op via cheap pre-check** (commit already in local HEAD) —
    `{ noChanges: true, outcome: 'in-sync', head, durationMs }`. No
    fetch, no lock acquired.
  - **No-op after reconcile** (local already matched remote after the
    fetch) — `{ noChanges: true, outcome: 'in-sync', oldCommit,
    newCommit, durationMs }`.
  - **Rebuilt** — `{ noChanges: false, rebuilt: true, outcome, oldCommit,
    newCommit, durationMs, conflictBranch? }`. `outcome` is one of
    `fast-forwarded`, `pushed-ahead`, `rebased`, `conflict-escaped`, or
    `fetch-failed` (see [`store/reconcile.ts`](../../apps/api/src/store/reconcile.ts)).
- **500 response** means the reconcile happened but the in-memory
  rebuild threw partway. The pod's in-memory state and FTS index are
  in an undefined state — restart the pod:

  ```bash
  kubectl -n codeforphilly-ng rollout restart deploy/codeforphilly
  ```

- **Outside-the-pod observability** — every reload logs an info line
  with the outcome + commits; failures log error. Search the pod logs
  for `hot-reload` to audit the most recent firings. The data repo's
  Actions run for `notify-deployments.yml` shows the HTTP status per target.

## Fetch from the pod's data clone

The pod's bare clone lives in an `emptyDir` at `/app/data` and may briefly hold commits the push daemon hasn't shipped to GitHub yet (or that got escape-hatched onto a `conflicts/*` branch — those *are* always pushed, see [`apps/api/src/store/reconcile.ts`](../../apps/api/src/store/reconcile.ts)). When you want to inspect the pod's view of the data repo without exposing any network ports, add it as a git remote via the `ext::` transport.

```bash
cd /path/to/codeforphilly-data

git config protocol.ext.allow always
git remote add pod 'ext::sh /path/to/codeforphilly-ng/scripts/git-pod-uploadpack.sh'

git fetch pod
git log --oneline origin/published..pod/published   # unpushed commits, if any
```

The helper script resolves the current pod by label selector, so it survives restarts. Override via env for the cluster you're targeting:

| Var | Default | Production |
| --- | --- | --- |
| `CFP_POD_KUBECONFIG` | `~/.kube/cfp-sandbox-cluster-kubeconfig.yaml` | the live cluster kubeconfig |
| `CFP_POD_NAMESPACE` | `codeforphilly-rewrite-sandbox` | `codeforphilly-ng` |
| `CFP_POD_SELECTOR` | `app.kubernetes.io/name=codeforphilly` | same |
| `CFP_POD_DATA_PATH` | `/app/data` | same |

**Read-only by design** — `git upload-pack` only serves fetch; pushing back to the pod would bypass gitsheets + in-memory state and fight the push daemon. Pull what you need to your local clone, reason about it there, then push to `origin` if appropriate.

## Helpful commands

```bash
# Watch a deploy
kubectl -n codeforphilly-ng rollout status deploy/codeforphilly

# Last 10 GitOps deploys (merge commits on deploys/k8s-manifests)
gh-axi -R CodeForPhilly/cfp-live-cluster pr list --base deploys/k8s-manifests --state merged --limit 10

# Which release is running?
kubectl -n codeforphilly-ng get deploy codeforphilly -o jsonpath='{.spec.template.spec.containers[0].image}'

# Pod resource use
kubectl -n codeforphilly-ng top pod

# Force a config / secret reload (env is read at pod start)
kubectl -n codeforphilly-ng rollout restart deploy/codeforphilly
```
