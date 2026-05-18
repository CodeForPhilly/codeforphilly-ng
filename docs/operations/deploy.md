# Deploying codeforphilly-rewrite

This guide covers the artifacts in [`deploy/`](../../deploy/), the boot sequence
inside the container, and the operational expectations of the staging and
production environments. The authoritative architectural contract is
[specs/architecture.md](../../specs/architecture.md#deploy); this document is
the runbook that implements it.

> See also: [secrets.md](secrets.md) for the secret contract, [runbook.md](runbook.md)
> for incident response.

## TL;DR — anatomy

```
+----------------------+
|  GitHub Actions CI   |     deploy-staging.yml / deploy-production.yml
+----------+-----------+
           | docker build / push
           v
+----------------------+
|  GHCR image          |     ghcr.io/codeforphilly/codeforphilly-ng:<sha>
+----------+-----------+
           | helm upgrade --install
           v
+----------------------+
|  k8s Deployment      |     1 replica, Recreate strategy, PVC + Secrets + ConfigMap
|   (api + spa)        |
+----------+-----------+
           |
   /api/*  v   /*       (fallthrough)
+---------------+   +-----------------------+
| Fastify routes |  |  apps/web/dist (SPA)  |
+----------------+   +-----------------------+
```

The image holds **both** the API and the built SPA. There is no separate web
container. The single replica is a hard architectural constraint
([specs/architecture.md](../../specs/architecture.md#process-model)).

## Image

### Build

```bash
docker build -t ghcr.io/codeforphilly/codeforphilly-ng:dev .
```

Three stages — `deps` (full install), `build` (compile both workspaces, prune
dev deps), `runtime` (alpine + git + ca-certificates + tini). Final image runs
as `node` (uid 1000) per the `securityContext` in the Helm chart.

### Run (local smoke test)

```bash
docker run --rm -p 3001:3001 \
  -e CFP_DATA_REMOTE=https://github.com/CodeForPhilly/codeforphilly-data-snapshot.git \
  -e STORAGE_BACKEND=filesystem \
  -e CFP_PRIVATE_STORAGE_PATH=/app/private-storage \
  -e CFP_JWT_SIGNING_KEY="$(openssl rand -base64 48)" \
  -e GITHUB_OAUTH_CLIENT_ID=local \
  -e GITHUB_OAUTH_CLIENT_SECRET=local \
  ghcr.io/codeforphilly/codeforphilly-ng:dev

curl http://localhost:3001/api/health        # liveness
curl http://localhost:3001/api/health/ready  # readiness
curl http://localhost:3001/                  # SPA index.html
```

## Boot sequence

The container entrypoint (`deploy/docker/entrypoint.sh`) does, in order:

1. Validate `CFP_DATA_REPO_PATH` is set.
2. If `CFP_DATA_REMOTE` is set:
   - If the target is already a git repo, `git fetch` + `git reset --hard origin/<branch>`.
   - Otherwise `git clone --depth=1 --branch <branch>`.
3. Configure git author identity on the local repo (so any commit the API
   makes carries `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`).
4. `exec node apps/api/dist/index.js`.

Inside node, `buildApp()` then registers plugins in order
([apps/api/src/app.ts](../../apps/api/src/app.ts)): env validation → CORS →
cookies → trace IDs → error mapper → **store boot (loads public + private into
memory)** → services (FTS) → rate limit → idempotency → session middleware →
swagger → routes → static SPA. The Fastify `listen()` call doesn't fire until
all of those resolve, so by the time `/api/health/ready` can be hit, both
stores have loaded.

This matches the boot-order section of [deploy.md plan](../../plans/deploy.md).

## Helm chart

Chart lives at [`deploy/charts/codeforphilly/`](../../deploy/charts/codeforphilly/).
Three values files:

- `values.yaml` — defaults (1 replica, Recreate, PVC for the data repo, S3 backend, ingress with cert-manager)
- `values.staging.yaml` — staging host, filesystem private store, scrubbed-snapshot data remote
- `values.production.yaml` — production hosts, S3 private store, real data remote, SSH deploy key

### Install

```bash
# Staging (first time)
kubectl create namespace codeforphilly-staging
kubectl -n codeforphilly-staging apply -f path/to/staging-secrets.yaml  # see secrets.md
helm upgrade --install codeforphilly-staging \
  deploy/charts/codeforphilly \
  --namespace codeforphilly-staging \
  -f deploy/charts/codeforphilly/values.staging.yaml \
  --set image.tag=sha-<sha>

# Production (first time)
kubectl create namespace codeforphilly
kubectl -n codeforphilly apply -f path/to/production-secrets.yaml
helm upgrade --install codeforphilly \
  deploy/charts/codeforphilly \
  --namespace codeforphilly \
  -f deploy/charts/codeforphilly/values.production.yaml \
  --set image.tag=v<x.y.z>
```

### What the chart provisions

| Resource | Purpose |
|----------|---------|
| `Deployment` | 1 replica, `Recreate` strategy, mounts PVC at `/app/data` |
| `Service` (ClusterIP) | Fronts the pod on port 80 → container 3001 |
| `Ingress` | nginx + cert-manager; staging + production hosts |
| `PersistentVolumeClaim` (data) | Working tree for the gitsheets data repo (5Gi default) |
| `PersistentVolumeClaim` (private, staging) | Local jsonl store when `storage.backend=filesystem` |
| `ConfigMap` | Non-secret env (`NODE_ENV`, paths, `CFP_DATA_REMOTE`, etc.) |
| `ServiceAccount` | Empty default — no in-cluster API access needed |

Secrets are **not** templated in the chart. They are created out-of-band — see
[secrets.md](secrets.md).

### Probes

- **Liveness** — `GET /api/health` every 10s. The pod is killed only after
  three consecutive failures (~30s).
- **Readiness** — `GET /api/health/ready` every 5s. Returns 503 until the
  store plugins have finished decorating Fastify (gitsheets working tree
  cloned + private store loaded). Once green, ingress routes traffic.

## CI/CD

Two deploy workflows in `.github/workflows/`:

- `deploy-staging.yml` — triggered on push to `main`. Builds + pushes the
  image tagged `sha-<short>` and `staging-latest`, then `helm upgrade --install`
  to `codeforphilly-staging`. Gated by GitHub Environment "staging" (first
  run requires manual approval; secrets are scoped per-environment).
- `deploy-production.yml` — triggered on tag push matching `v*.*.*`. Same
  build, deploys to namespace `codeforphilly`. Gated by Environment
  "production" — every deploy goes through an approval gate.

Both use `--atomic --wait --timeout 5m` so a failed rollout auto-reverts.

### GitHub Environment secrets

| Environment | Secret | Purpose |
|-------------|--------|---------|
| staging | `KUBECONFIG_STAGING` | base64-encoded kubeconfig with rights only in `codeforphilly-staging` |
| production | `KUBECONFIG_PRODUCTION` | base64-encoded kubeconfig with rights only in `codeforphilly` |

The kubeconfigs should be scoped to the namespace via RBAC — the service
account they reference should not have cluster-admin.

## Data repo on disk

In production the API operates on a working tree at `/app/data` backed by a
PVC. On every boot the entrypoint refreshes that tree from `CFP_DATA_REMOTE`
(`git fetch && git reset --hard`). The push daemon then pushes commits made
during the pod's lifetime back to the remote.

Implications:

- **PVC contents are ephemeral.** Killing the pod and recreating it does
  *not* lose data because the source of truth is the git remote, not the
  PVC. The PVC just avoids re-cloning on every restart.
- **The deploy key matters.** If `CFP_DATA_REMOTE` is SSH (the production
  default), the entrypoint relies on `GIT_SSH_COMMAND` (rendered into the
  ConfigMap) pointing at the mounted private key. Rotation: replace the
  Secret, restart the pod. See [secrets.md](secrets.md#data-repo-deploy-key).

## Bucket provisioning

Production uses an S3-compatible bucket for private storage
([specs/behaviors/private-storage.md](../../specs/behaviors/private-storage.md)).
The bucket is **not** Helm-managed — it's provisioned out-of-band and the
Helm chart just consumes the credentials.

Recommended provider: **Cloudflare R2** (zero egress, pennies per month,
S3-compatible API). Backblaze B2 or AWS S3 also work. MinIO inside the
cluster is acceptable for cost reasons but trades operational simplicity
for storage simplicity.

Required bucket configuration:

- **Versioning enabled.** Hard requirement per
  [private-storage.md](../../specs/behaviors/private-storage.md#bucket-requirements).
  Every PUT increments the object's version; the previous `.jsonl` is
  recoverable. Verify with `aws s3api get-bucket-versioning`.
- **Lifecycle rule** deleting non-current versions after 365 days.
- **IAM policy** scoped to the bucket only — `s3:GetObject`,
  `s3:PutObject`, `s3:ListBucket`, `s3:GetObjectVersion`. No cross-bucket
  access; no console access for the service principal.
- **Endpoint URL** plugged into `S3_ENDPOINT` (Helm `publicEnv.S3_ENDPOINT`).
- **Bucket name** plugged into `S3_BUCKET`.
- **Region** (or a placeholder R2 region) into `S3_REGION`.
- **Access keys** stored in the `codeforphilly-secrets` Secret as
  `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.

Two physical surfaces: one bucket for staging, one for production. Or one
bucket with two prefixes (`staging/profiles.jsonl`, `prod/profiles.jsonl`)
if cost is tight — the path string is configurable via the private-store
implementation but conventionally we use separate buckets.

Until a real bucket exists, staging runs on `storage.backend=filesystem`
backed by a PVC — see `values.staging.yaml`. The cutover from filesystem
to S3 is a values change only; the in-memory model is identical.

## Environment variables (reference)

The runtime contract. See [`.env.example`](../../.env.example) for the
exhaustive list with comments; the table below tracks what gets *mounted*
into a production pod.

| Variable | Source | Notes |
|----------|--------|-------|
| `NODE_ENV` | ConfigMap | `production` |
| `PORT` | ConfigMap | `3001` |
| `HOST` | ConfigMap | `0.0.0.0` |
| `CFP_DATA_REPO_PATH` | ConfigMap | `/app/data` (PVC mount) |
| `CFP_DATA_REMOTE` | ConfigMap | git URL (ssh in prod, https for snapshot) |
| `CFP_DATA_BRANCH` | ConfigMap | `main` |
| `CFP_WEB_DIST_PATH` | Dockerfile ENV | `/app/apps/web/dist` |
| `STORAGE_BACKEND` | ConfigMap | `s3` (prod) / `filesystem` (staging) |
| `CFP_PRIVATE_STORAGE_PATH` | ConfigMap | `/app/private-storage` (when filesystem) |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` | ConfigMap | Bucket addressing |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | **Secret** | Bucket credentials |
| `GITHUB_OAUTH_CLIENT_ID` | ConfigMap | OAuth app client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | **Secret** | OAuth app client secret |
| `CFP_JWT_SIGNING_KEY` | **Secret** | HS256 key (`openssl rand -base64 64`) |
| `SAML_PRIVATE_KEY` / `SAML_CERTIFICATE` | **Secret** | Slack IdP cert chain |
| `GIT_SSH_COMMAND` | ConfigMap (rendered) | Wires `ssh` to the mounted deploy key |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | ConfigMap | Identity on push-daemon commits |

## Rollback

```bash
# Roll back to the previous Helm release
helm rollback codeforphilly-staging --namespace codeforphilly-staging

# Or pin to a specific image
helm upgrade codeforphilly-staging deploy/charts/codeforphilly \
  --namespace codeforphilly-staging \
  --reuse-values \
  --set image.tag=sha-<previous>
```

Note: because every commit/mutation pushes to the data remote synchronously,
rolling the container back is *not* a data rollback. Data rollback is `git
revert` on the data repo.

## Known unknowns

- **Cluster choice.** Plan assumes the existing CFP k8s cluster (`k8s.phl.io`).
  If a different cluster is targeted, regenerate `KUBECONFIG_STAGING` /
  `KUBECONFIG_PRODUCTION` and update the ingress hosts.
- **First staging stand-up.** Provisioning the namespace + creating the
  per-environment Secrets is a one-time human operation. The first
  `helm upgrade --install` requires those Secrets to already exist.
- **MinIO option.** If the cluster doesn't have an S3 provider available,
  add a MinIO subchart under `deploy/charts/codeforphilly/charts/`. Out of
  scope for v1.
