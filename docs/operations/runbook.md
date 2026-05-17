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
| `[entrypoint] ERROR: CFP_DATA_REMOTE is unset` | The PVC was wiped and the chart isn't providing the remote URL. | Check ConfigMap `<release>-env`; ensure `publicEnv.CFP_DATA_REMOTE` is set in the active values file. |
| `fatal: could not read Username for 'https://...'` or `Permission denied (publickey)` | Bad/missing data-repo credentials. | Verify the `codeforphilly-data-deploy-key` Secret holds a valid `id_ed25519` whose public key has push access to the data repo. See [secrets.md](secrets.md#data-repo-deploy-key). |
| `Failed to open public gitsheets store` | Working tree corrupt or missing `.gitsheets/` configs. | Exec into the pod, inspect `/app/data/.gitsheets/`. Recovery: wipe the PVC and let the entrypoint re-clone (`kubectl delete pvc <release>-data` → recreate via `helm upgrade`). |
| `Failed to load private store (s3)` | Bucket creds wrong, bucket gone, or network ACL blocks egress. | Confirm `S3_*` env in the ConfigMap + Secret. From the pod, `curl $S3_ENDPOINT` to confirm reachability. |
| `environment variable ... is required` | A required env (`CFP_DATA_REPO_PATH`, `STORAGE_BACKEND`, `CFP_JWT_SIGNING_KEY`) is missing. | Helm values regression. Compare against `values.production.yaml`. |

### 2. Drop into the pod (if it stays up long enough)

```bash
kubectl -n codeforphilly debug -it deploy/codeforphilly \
  --image=alpine --target=api -- sh
```

From inside:

```bash
# Is the data repo really there?
ls -la /app/data /app/data/.gitsheets

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
# Roll back to the last-known-good Helm release
helm -n codeforphilly history codeforphilly
helm -n codeforphilly rollback codeforphilly <revision>

# Or pin to a previous image
helm upgrade codeforphilly deploy/charts/codeforphilly \
  --namespace codeforphilly \
  --reuse-values \
  --set image.tag=<known-good-tag>
```

Data is **not** in the PVC long-term; it's in the git remote. Deleting the
PVC and letting the entrypoint re-clone is safe.

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

## Helpful commands

```bash
# Watch a deploy
kubectl -n codeforphilly rollout status deploy/codeforphilly

# Last 10 Helm releases
helm -n codeforphilly history codeforphilly

# Pod resource use
kubectl -n codeforphilly top pod

# Force a config reload
kubectl -n codeforphilly rollout restart deploy/codeforphilly
```
