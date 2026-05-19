# Deploying codeforphilly-ng

This guide covers the deploy surface and the boot sequence inside the
container. The authoritative architectural contract is
[specs/architecture.md](../../specs/architecture.md#deploy); this document
is the runbook that implements it.

> See also: [sandbox-deploy.md](sandbox-deploy.md) for the manual sandbox
> bring-up procedure, [secrets.md](secrets.md) for the secret contract,
> [runbook.md](runbook.md) for incident response.

## TL;DR — anatomy

```
+----------------------+
|  GitHub Actions CI   |     ci.yml (build + test on PR / main)
+----------+-----------+
           | docker build / push (manual today)
           v
+----------------------+
|  GHCR image          |     ghcr.io/codeforphilly/codeforphilly-ng:<tag>
+----------+-----------+
           | kubectl apply -k  (via GitOps below)
           v
+----------------------+
|  k8s Deployment      |     1 replica, Recreate strategy, PVC + Secrets + ConfigMap
|   (api + spa)        |
+----------+-----------+
           |
   /api/*  v   /*       (fallthrough)
+----------------+   +-----------------------+
| Fastify routes |   |  apps/web/dist (SPA)  |
+----------------+   +-----------------------+
```

The image holds **both** the API and the built SPA. There is no separate web
container. The single replica is a hard architectural constraint
([specs/architecture.md](../../specs/architecture.md#process-model)).

## Manifests

Kustomize base + per-environment overlays at
[`deploy/kustomize/`](../../deploy/kustomize/). The base lives in
`deploy/kustomize/base/`; environment overlays under
`deploy/kustomize/overlays/<env>/`.

The base ships everything the cluster needs in any environment:
`Deployment`, `Service`, `ConfigMap`, `PersistentVolumeClaim`s, `Gateway` +
`HTTPRoute` (per-env hostname patched in the overlay), `ServiceAccount`.
Sealed `Secret`s live only in overlays (sealed against the target cluster's
sealed-secrets controller).

Cluster-level deploys are driven by the
[`cfp-sandbox-cluster`](https://github.com/CodeForPhilly/cfp-sandbox-cluster)
GitOps repo, which pulls the workload from this repo's main branch, composes
its own per-cluster Gateway/HTTPRoute (under `_gateways/codeforphilly-ng.yaml`)
and SealedSecrets (under `codeforphilly-ng.secrets/`), and applies on merge.
Production stand-up will follow the same pattern under a `cfp-prod-cluster`
repo.

For a one-shot manual apply (useful pre-GitOps or for an offline cluster):

```bash
kubectl apply -k deploy/kustomize/overlays/sandbox
```

## Image

### Build

```bash
docker build --platform=linux/amd64 \
  -t ghcr.io/codeforphilly/codeforphilly-ng:dev .
```

Three stages — `deps` (full install), `build` (compile shared, api, web — in
that order, since web/api consume shared's compiled output), `runtime`
(alpine + git + ca-certificates + tini). Final image runs as `node`
(uid 1000) per the `securityContext` in `deploy/kustomize/base/deployment.yaml`.

`--platform=linux/amd64` is required on Apple Silicon hosts — the cluster
nodes are amd64 and won't pull an arm64-only manifest.

### Run (local smoke test)

```bash
docker run --rm -p 3001:3001 \
  -e CFP_DATA_REMOTE=https://github.com/CodeForPhilly/codeforphilly-data.git \
  -e CFP_DATA_BRANCH=fixture \
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

The container entrypoint (`deploy/docker/entrypoint.sh`) only handles the
bits that *must* run before the Node process exists:

- Trusts the PVC mount via `git config --global safe.directory`.
- Sets a pseudonymous git identity (`CodeForPhilly API
  <api@users.noreply.codeforphilly.org>`) for any committer line a future
  rebase might write.
- On first pod boot — and only then — does a full-history `git clone` of
  `CFP_DATA_REMOTE` into `CFP_DATA_REPO_PATH` when no `.git` directory
  exists. On subsequent boots the PVC already holds a clone; no clone is
  performed.
- Refreshes `origin`'s URL to whatever `CFP_DATA_REMOTE` is set to (lets
  operators rotate the remote without re-cloning the PVC).
- `exec`s the API. That's all — about a dozen lines of shell now.

Then `exec node apps/api/dist/index.js`. Inside node, `buildApp()` registers
plugins ([apps/api/src/app.ts](../../apps/api/src/app.ts)) in order: env →
CORS → cookies → trace IDs → error mapper → **store** (loads public +
private into memory) → **reconcile** (fetch + ff/rebase/escape-hatch against
origin — see below) → **push daemon** (starts pushing transact'd commits to
`CFP_DATA_REMOTE`) → services (FTS) → rate limit → idempotency → session
middleware → swagger → routes → static SPA. Fastify's `listen()` doesn't
fire until all of those resolve, so once `/api/health/ready` returns 200
both stores have loaded **and** the working tree has been reconciled with
origin.

### Reconciliation state machine

Lives in [`apps/api/src/store/reconcile.ts`](../../apps/api/src/store/reconcile.ts)
and is invoked at boot by the reconcile plugin. Same state machine the
shell used to run, just structured Node so exit codes propagate naturally
and the same code is reusable from the future hot-reload webhook (#65):

- in sync → no-op (`'in-sync'`)
- behind → fast-forward (`'fast-forwarded'`)
- ahead → push (`'pushed-ahead'`; push daemon retries on push failure)
- diverged + clean rebase → rebase + push (`'rebased'`)
- diverged + conflicts → abort rebase, create + push a
  `conflicts/<UTC-timestamp>` branch from the pre-rebase HEAD, hard-reset
  local to origin (`'conflict-escaped'`; logged at ERROR level so operators
  see it in production logs)
- fetch itself fails (network blip) → log warn, continue with local state
  (`'fetch-failed'`)

When `CFP_DATA_REMOTE` is unset (typical local dev), the reconcile plugin
skips reconciliation entirely.

## Probes

- **Liveness** — `GET /api/health` every 30s. The pod is killed only after
  three consecutive failures (~90s).
- **Readiness** — `GET /api/health/ready` every 5s. Returns 503 until the
  store plugins have finished decorating Fastify. Once green, the Gateway
  routes traffic.

## Data repo on disk

The API operates on a working tree at `/app/data` backed by a PVC. The
entrypoint ensures the working tree exists (cloning on first boot); the
API-side reconcile plugin then synchronizes that tree with `CFP_DATA_REMOTE`
on every boot, and the push daemon pushes commits made during the pod's
lifetime back to the remote.

Implications:

- **PVC contents are durable enough to outlive a single pod**, which lets the
  push daemon finish pushing any commits made just before pod terminate.
  But the source of truth is the git remote, not the PVC — wiping the PVC
  is safe (the next boot re-clones).
- **The deploy key matters.** When `CFP_DATA_REMOTE` is SSH (the
  default), the entrypoint relies on `GIT_SSH_COMMAND` (set in the
  ConfigMap) pointing at the mounted private key. Rotation: replace the
  SealedSecret, restart the pod. See
  [secrets.md](secrets.md#data-repo-deploy-key) and the rotation procedure
  in [sandbox-deploy.md](sandbox-deploy.md#rotating-the-deploy-key).

## Bucket provisioning (production)

Production uses an S3-compatible bucket for private storage
([specs/behaviors/private-storage.md](../../specs/behaviors/private-storage.md)).
The bucket is provisioned out-of-band and the manifests consume its
credentials via a SealedSecret.

Recommended provider: **Cloudflare R2** (zero egress, pennies per month,
S3-compatible API). Backblaze B2 or AWS S3 also work. MinIO inside the
cluster is acceptable for cost reasons but trades operational simplicity
for storage simplicity.

Required bucket configuration:

- **Versioning enabled.** Hard requirement per
  [private-storage.md](../../specs/behaviors/private-storage.md#bucket-requirements).
- **Lifecycle rule** deleting non-current versions after 365 days.
- **IAM policy** scoped to the bucket only — `s3:GetObject`, `s3:PutObject`,
  `s3:ListBucket`, `s3:GetObjectVersion`. No cross-bucket access; no console
  access for the service principal.
- **Endpoint URL** → `S3_ENDPOINT` (ConfigMap).
- **Bucket name** → `S3_BUCKET`.
- **Region** → `S3_REGION`.
- **Access keys** → `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (Secret).

## Environment variables (reference)

See [`.env.example`](../../.env.example) for the exhaustive list with
comments. Production pod gets these mounted:

| Variable | Source | Notes |
|----------|--------|-------|
| `NODE_ENV` | ConfigMap | `production` |
| `PORT` | ConfigMap | `3001` |
| `HOST` | ConfigMap | `0.0.0.0` |
| `CFP_DATA_REPO_PATH` | ConfigMap | `/app/data` (PVC mount) |
| `CFP_DATA_REMOTE` | Secret | git URL (ssh in prod) |
| `CFP_DATA_BRANCH` | ConfigMap | e.g. `fixture` / `main` |
| `CFP_WEB_DIST_PATH` | ConfigMap | `/app/apps/web/dist` |
| `STORAGE_BACKEND` | ConfigMap | `s3` (prod) / `filesystem` (sandbox) |
| `CFP_PRIVATE_STORAGE_PATH` | ConfigMap | `/app/private-storage` (when filesystem) |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` | ConfigMap | Bucket addressing |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | **Secret** | Bucket credentials |
| `GITHUB_OAUTH_CLIENT_ID` | **Secret** | OAuth app client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | **Secret** | OAuth app client secret |
| `CFP_JWT_SIGNING_KEY` | **Secret** | HS256 key (`openssl rand -base64 64`) |
| `SAML_PRIVATE_KEY` / `SAML_CERTIFICATE` | **Secret** | Slack IdP cert chain |
| `GIT_SSH_COMMAND` | ConfigMap | Wires `ssh` to the mounted deploy key |

## Rollback

Two distinct rollback flavors:

- **Pod / image rollback** — change the image tag in the GitOps repo's
  `images:` override (or, for an out-of-band hotfix, `kubectl set image
  deployment/codeforphilly ...`). The deployment's `Recreate` strategy
  serializes the swap; a few seconds of `503` on the readiness probe is
  expected while the new pod boots.
- **Data rollback** — `git revert` (or `git push --force-with-lease` after
  a careful local rebase) on the data repo. The next pod-boot entrypoint
  reconciliation will pick up the change. Don't conflate the two: rolling
  the image back does not undo data writes the API has already pushed.
