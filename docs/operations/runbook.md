# Runbook

On-call playbooks for the codeforphilly-rewrite production service.

> See also: [monitoring.md](monitoring.md) for the alarm signals that page
> on-call, [cutover.md](cutover.md) for cutover-specific procedures.

## "API won't boot"

Symptoms: pod CrashLoopBackOff, `kubectl describe pod` shows the container
restarting, no `/api/health` response.

### 1. Read the logs first

```bash
kubectl -n codeforphilly logs deploy/codeforphilly --previous
kubectl -n codeforphilly logs deploy/codeforphilly --tail=200
```

Look for one of the four common boot failures:

| Log line excerpt | Cause | Fix |
|------------------|-------|-----|
| `[entrypoint] ERROR: CFP_DATA_REMOTE is unset` | The Secret containing `CFP_DATA_REMOTE` isn't reaching the pod. | Check `kubectl get secret codeforphilly-secrets -o yaml`; verify the SealedSecret in the GitOps repo decrypted successfully (look at the sealed-secrets controller logs). |
| `fatal: could not read Username for 'https://...'` or `Permission denied (publickey)` | Bad/missing data-repo credentials. | Verify the `codeforphilly-data-deploy-key` Secret holds a valid `id_ed25519` whose public key has push access to the data repo. See [secrets.md](secrets.md#data-repo-deploy-key). |
| `Failed to open public gitsheets store` | Bare clone corrupt or missing `.gitsheets/` configs. | Exec into the pod, inspect `/app/data/refs/`, `/app/data/objects/`, and verify `.gitsheets/` exists in HEAD via `git --git-dir=/app/data show HEAD:.gitsheets`. Recovery: restart the pod — `data` is an `emptyDir`, so a fresh pod re-clones from `CFP_DATA_REMOTE` automatically. |
| `Failed to load private store (s3)` | Bucket creds wrong, bucket gone, or network ACL blocks egress. | Confirm `S3_*` env in the ConfigMap + Secret. From the pod, `curl $S3_ENDPOINT` to confirm reachability. |
| `environment variable ... is required` | A required env (`CFP_DATA_REPO_PATH`, `STORAGE_BACKEND`, `CFP_JWT_SIGNING_KEY`) is missing. | Manifest regression. Compare against `deploy/kustomize/base/configmap.yaml` + the GitOps repo's SealedSecret. |

### 2. Drop into the pod (if it stays up long enough)

```bash
kubectl -n codeforphilly debug -it deploy/codeforphilly \
  --image=alpine --target=api -- sh
```

From inside:

```bash
# Is the bare data repo really there? Bare gitdir lives at the path root —
# no .git subdir; expect HEAD, config, objects/, refs/ at the top.
ls -la /app/data
git --git-dir=/app/data show HEAD:.gitsheets

# Are env vars present?
env | grep -E '^(CFP_|S3_|STORAGE_|GITHUB_)' | sort

# Can we reach the bucket?
apk add --no-cache curl
curl -v "$S3_ENDPOINT"

# Can we reach the data remote?
git ls-remote "$CFP_DATA_REMOTE" 2>&1 | head
```

### 3. Last-resort recovery

If the cluster state is unrecoverable but the data remote is intact:

```bash
# Revert the most recent GitOps deploy (the cluster repo's deploy PR is a
# normal merge commit on `deploys/k8s-manifests`)
gh -R CodeForPhilly/cfp-sandbox-cluster pr list --base deploys/k8s-manifests --state merged
git -C ~/Repositories/cfp-sandbox-cluster revert <merge-sha> --mainline 1
git -C ~/Repositories/cfp-sandbox-cluster push origin deploys/k8s-manifests

# Or pin to a previous image by editing the GitOps repo's
# .holo/branches/k8s-manifests/codeforphilly-ng/app/manifests.toml's image
# tag, committing on a hotfix branch, and merging through the deploy PR.

# Out-of-band hotfix (bypasses GitOps — fix the repo afterward):
kubectl -n codeforphilly-rewrite-sandbox set image \
  deploy/codeforphilly codeforphilly=ghcr.io/codeforphilly/codeforphilly-ng:<known-good-tag>
```

The bare data clone lives in an `emptyDir` — re-cloned from the git remote on
every pod boot. Pod restart is the recovery primitive; there's no PVC to
delete. (A `codeforphilly-private` PVC still exists for the S3-fallback
private store; only `codeforphilly-data` was retired.)

## "Readiness flapping / 503 spikes"

Readiness probe (`/api/health/ready`) returns 503 only when the store
decorators are missing — that only happens during boot. Mid-life flapping
likely means:

- Liveness probe (`/api/health`) failed and k8s is restarting the pod. Look
  at the previous logs.
- Memory pressure → OOMKilled. Bump `resources.limits.memory` or lower
  `NODE_OPTIONS=--max-old-space-size`.

## "Mutations succeed in UI but don't appear on GitHub"

Push daemon failure. Check logs for git push errors. Common causes:

- Deploy key removed/expired — see [secrets.md](secrets.md#data-repo-deploy-key).
- Remote branch protection rejecting the push.
- Network egress blocked.

The local working tree continues to accept writes — it's only the
asynchronous mirror to GitHub that's broken. Once fixed, the daemon will
push the backlog.

## Hot-reload webhook

The API exposes `POST /api/_internal/reload-data` so that a push to
`CFP_DATA_BRANCH` (typically `published`) propagates to the running pod
without rolling it. The `codeforphilly-data` repo's
`notify-deployments.yml` workflow calls this endpoint on every push.

See [specs/behaviors/storage.md#hot-reload](../../specs/behaviors/storage.md#hot-reload)
for the authoritative contract. Operationally:

- **Configured by** the `CFP_DATA_RELOAD_SECRET` env variable. When
  unset, the endpoint is still registered but returns 503 — the
  workflow's `curl` will exit non-zero and the operator must
  investigate. The secret value lives in the GitOps repo's
  `cfp-sandbox-cluster/codeforphilly-ng.secrets/` (or production
  equivalent) as a sealed Secret — not in the app repo.
- **Trigger manually** for debugging:

  ```bash
  SECRET=$(kubectl -n codeforphilly-rewrite-sandbox get secret \
    codeforphilly-ng -o jsonpath='{.data.CFP_DATA_RELOAD_SECRET}' | base64 -d)

  curl -sS -X POST https://next-v2.codeforphilly.org/api/_internal/reload-data \
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
  kubectl -n codeforphilly-rewrite-sandbox rollout restart deploy/codeforphilly
  ```

- **Outside-the-pod observability** — every reload logs an info line
  with the outcome + commits; failures log error. Search the pod logs
  for `hot-reload` to audit the most recent firings.

## Fetch from the pod's data clone

The pod's working tree lives on a PVC at `/app/data` inside the container and may briefly hold commits the push daemon hasn't shipped to GitHub yet (or that got escape-hatched onto a `conflicts/*` branch — those *are* always pushed, see [`apps/api/src/store/reconcile.ts`](../../apps/api/src/store/reconcile.ts)). When you want to inspect the pod's view of the data repo without exposing any network ports, add it as a git remote via the `ext::` transport.

```bash
cd /path/to/codeforphilly-data

git config protocol.ext.allow always
git remote add pod 'ext::sh /path/to/codeforphilly-ng/scripts/git-pod-uploadpack.sh'

git fetch pod
git log --oneline pod/published..pod/published   # whatever you're chasing
```

The helper script resolves the current pod by label selector, so it survives restarts. Override via env if your setup differs:

| Var | Default |
|---|---|
| `CFP_POD_KUBECONFIG` | `~/.kube/cfp-sandbox-cluster-kubeconfig.yaml` |
| `CFP_POD_NAMESPACE` | `codeforphilly-rewrite-sandbox` |
| `CFP_POD_SELECTOR` | `app.kubernetes.io/name=codeforphilly` |
| `CFP_POD_DATA_PATH` | `/app/data` |

**Read-only by design** — `git upload-pack` only serves fetch; pushing back to the pod would bypass gitsheets + in-memory state and fight the push daemon. Pull what you need to your local clone, reason about it there, then push to `origin` if appropriate.

## Helpful commands

```bash
# Watch a deploy
kubectl -n codeforphilly rollout status deploy/codeforphilly

# Last 10 GitOps deploys (merge commits on deploys/k8s-manifests)
gh -R CodeForPhilly/cfp-sandbox-cluster pr list --base deploys/k8s-manifests --state merged --limit 10

# Pod resource use
kubectl -n codeforphilly top pod

# Force a config reload
kubectl -n codeforphilly rollout restart deploy/codeforphilly
```
