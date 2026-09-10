# Deploying codeforphilly-ng

This guide covers the deploy surface and the boot sequence inside the
container. The authoritative architectural contract is
[specs/architecture.md](../../specs/architecture.md#deploy); this document
is the runbook that implements it.

> See also: [releases.md](releases.md) for how an image gets published,
> [sandbox-deploy.md](sandbox-deploy.md) for the sandbox cluster specifics
> and the manual escape hatch, [secrets.md](secrets.md) for the secret
> contract, [runbook.md](runbook.md) for incident response,
> [cutover.md](cutover.md) for the production hostname move.

## Environments

| | GitOps repo | Namespace | Host | Pinned at |
|---|---|---|---|---|
| **Production** | [`cfp-live-cluster`](https://github.com/CodeForPhilly/cfp-live-cluster) | `codeforphilly-ng` | `next.codeforphilly.org` (pre-cutover); `codeforphilly.org` after | `v0.2.0` as of 2026-09-10 |
| **Sandbox** | [`cfp-sandbox-cluster`](https://github.com/CodeForPhilly/cfp-sandbox-cluster) | `codeforphilly-rewrite-sandbox` | `next-v2.codeforphilly.org` | same tag, bumped ahead of prod |

Legacy laddr runs in the live cluster too, in namespace `code-for-philly`.
There is no separate staging environment — the sandbox plays that role.

## TL;DR — anatomy

```
+----------------------+
|  GitHub Actions      |     ci.yml (build + test on PR / develop)
|                      |     release-*.yml (develop -> "Release: vX.Y.Z" PR -> tag)
|                      |     container-publish.yml (on tag push)
+----------+-----------+
           | docker build / push
           v
+----------------------+
|  GHCR image          |     ghcr.io/codeforphilly/codeforphilly-ng:vX.Y.Z (+ :latest)
+----------+-----------+
           | cluster repo bumps its pin -> "Build k8s-manifests" -> deploy PR -> apply
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

## Release → image

Image publishing is automated; nobody `docker push`es a release. The flow is
in [releases.md](releases.md):

1. Work merges into `develop`; pushing `develop` opens/updates a
   `Release: vX.Y.Z` PR into `main`.
2. Merging that PR tags `vX.Y.Z`; the tag push triggers
   `.github/workflows/container-publish.yml`, which builds and pushes
   `ghcr.io/codeforphilly/codeforphilly-ng:vX.Y.Z` and `:latest`.

The old hand-built `:sandbox` tag still exists as an emergency escape hatch
([sandbox-deploy.md](sandbox-deploy.md#emergency-escape-hatch-manual-image--apply))
but is not how anything gets deployed.

## Image → cluster (GitOps)

Both cluster repos work the same way:

1. **Pin the release.** Two values in the cluster repo must move together:
   - `.holo/sources/codeforphilly-ng.toml` — `ref = "refs/tags/vX.Y.Z"`.
     hologit projects `deploy/kustomize/base/` from this repo at that tag.
   - `codeforphilly-ng/app/kustomization.yaml` — `images[].newTag: vX.Y.Z`.
2. **Merge to `main`** in the cluster repo. The **"Build k8s-manifests"**
   workflow projects the holobranch to `releases/k8s-manifests`, and a bot
   opens a PR from there into `deploys/k8s-manifests`.
3. **Merge the deploy PR.** That applies the manifests. The `Recreate`
   strategy swaps the pod; expect a short readiness gap while the new pod
   re-clones the data repo and reloads state.

Bump the sandbox first, let it soak, then bump prod.

Per-cluster concerns live in the cluster repo, not here: the Gateway +
HTTPRoute (`_gateways/codeforphilly-ng.yaml`), the SealedSecrets
(`codeforphilly-ng.secrets/`), and the per-environment patches in
`codeforphilly-ng/app/kustomization.yaml` (`CFP_SITE_HOST`,
`imagePullPolicy`, the extra `codeforphilly-saml` `envFrom` in prod).

## Manifests in this repo

Kustomize base at [`deploy/kustomize/base/`](../../deploy/kustomize/base/):
`Deployment`, `Service`, `ConfigMap`, the private-storage
`PersistentVolumeClaim`, `Gateway` + `HTTPRoute` templates (hostname
placeholder), `ServiceAccount`. This is what the cluster repos project.

[`deploy/kustomize/overlays/sandbox/`](../../deploy/kustomize/overlays/sandbox/)
is the pre-GitOps manual overlay (namespace, sealed secrets, hostname
patches). It is only used by the escape hatch in
[sandbox-deploy.md](sandbox-deploy.md); the sandbox cluster repo carries its
own equivalents.

## Image

### Build (local)

```bash
docker build --platform=linux/amd64 \
  -t ghcr.io/codeforphilly/codeforphilly-ng:dev .
```

Three stages — `deps` (full install), `build` (compile shared, api, web — in
that order, since web/api consume shared's compiled output), `runtime`
(alpine + git + ca-certificates + tini). Final image runs as `node`
(uid 1000) per the `securityContext` in `deploy/kustomize/base/deployment.yaml`.
The runtime stage ships only `dist/` output and production deps — no
`tsx`, no `apps/api/scripts/` — so operator scripts can't be run inside a
pod.

`--platform=linux/amd64` is required on Apple Silicon hosts — the cluster
nodes are amd64 and won't pull an arm64-only manifest. CI runners are amd64
already, so `container-publish.yml` has no platform flag.

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

- Trusts the data path via `git config --global safe.directory`.
- Sets a pseudonymous git identity (`CodeForPhilly API
  <api@users.noreply.codeforphilly.org>`) for any committer line the
  reconcile's commit-replay path might write.
- On first pod boot — `data` is an `emptyDir`, so this is every fresh
  pod — does a `git clone --bare --branch $CFP_DATA_BRANCH` of
  `CFP_DATA_REMOTE` into `CFP_DATA_REPO_PATH`. Bare means no working
  tree; gitsheets operates on the git object DB directly. See
  [`specs/behaviors/storage.md`](../../specs/behaviors/storage.md) →
  "The data clone is bare."
- Refreshes `origin`'s URL to whatever `CFP_DATA_REMOTE` is set to
  (operators can rotate the remote with a pod restart; the new
  `emptyDir` re-clones from the new URL).
- `exec`s the API. That's all.

Then `exec node apps/api/dist/index.js`. Inside node, `buildApp()` registers
plugins ([apps/api/src/app.ts](../../apps/api/src/app.ts)) in order: env →
CORS → cookies → trace IDs → error mapper → **store** (opens the bare
public clone via `openRepo({ gitDir })`, loads public + private into
memory) → **reconcile** (fetch + ff/rebase-replay/escape-hatch against
origin — see below) → **push daemon** (starts pushing transact'd commits to
`CFP_DATA_REMOTE`) → services (FTS) → rate limit → idempotency → session
middleware → swagger → routes → static SPA. Fastify's `listen()` doesn't
fire until all of those resolve, so once `/api/health/ready` returns 200
both stores have loaded **and** local refs have been reconciled with origin.

### Reconciliation state machine

Lives in [`apps/api/src/store/reconcile.ts`](../../apps/api/src/store/reconcile.ts)
and is invoked at boot by the reconcile plugin. Operates entirely on the
object DB via plumbing (`update-ref`, `merge-tree --write-tree`,
`commit-tree`) so it works against the bare clone with no working tree:

- in sync → no-op (`'in-sync'`)
- behind → fast-forward via `git update-ref refs/heads/<branch>` (CAS
  against old commit) (`'fast-forwarded'`)
- ahead → push (`'pushed-ahead'`; push daemon retries on push failure)
- diverged + clean replay → `merge-tree --write-tree` + `commit-tree`
  per local commit on top of remote tip, then `update-ref` + push
  (`'rebased'`)
- diverged + replay conflict → preserve pre-replay HEAD on
  `conflicts/<UTC-timestamp>`, push it, fast-forward local refs to
  remote tip (`'conflict-escaped'`; logged at ERROR level so operators
  see it in production logs)
- fetch itself fails (network blip) → log warn, continue with local state
  (`'fetch-failed'`)

When `CFP_DATA_REMOTE` is unset (typical local dev), the reconcile plugin
skips reconciliation entirely.

The same path runs mid-life when the hot-reload webhook fires — see
[runbook.md#hot-reload-webhook](runbook.md#hot-reload-webhook).

## Probes

- **Liveness** — `GET /api/health` every 30s. The pod is killed only after
  three consecutive failures (~90s).
- **Readiness** — `GET /api/health/ready` every 5s. Returns 503 until the
  store plugins have finished decorating Fastify. Once green, the Gateway
  routes traffic.

## Data repo on disk

The API operates on a **bare** clone at `/app/data` backed by an
`emptyDir` volume. The entrypoint clones (`git clone --bare`) on every
pod start since `emptyDir` doesn't survive restarts. Within a pod's
lifetime, the API-side reconcile plugin synchronizes local refs with
`CFP_DATA_REMOTE` (boot reconcile + hot-reload webhook), and the push
daemon pushes commits made during the pod's lifetime back to the
remote.

Implications:

- **No PVC for data.** The git remote is the source of truth; the
  pod's bare clone is recoverable from there. Pod restart is the
  recovery primitive — there's nothing to delete first, and no
  Multi-Attach errors during node failover.
- **The deploy key matters.** When `CFP_DATA_REMOTE` is SSH (the
  default), the entrypoint relies on `GIT_SSH_COMMAND` (set in the
  ConfigMap) pointing at the mounted private key. Rotation: replace
  the SealedSecret, restart the pod. See
  [secrets.md](secrets.md#data-repo-deploy-key).

## Private storage

Both sandbox and production run `STORAGE_BACKEND=filesystem` with
`CFP_PRIVATE_STORAGE_PATH=/app/private-storage` mounted from the
`codeforphilly-private` PersistentVolumeClaim
(`deploy/kustomize/base/pvc-private.yaml`, `linode-block-storage-retain`,
1Gi). The two `.jsonl` files there (`profiles.jsonl`,
`legacy-passwords.jsonl`) are loaded into memory at boot and rewritten
atomically on every private-side mutation.

Implications:

- **The PVC is the private store.** It survives pod restarts and image
  bumps. The hot-reload webhook does **not** reload it — a pod restart is
  the only way to pick up files placed there by hand
  ([legacy-credentials-import.md](legacy-credentials-import.md)).
- **No versioning.** Unlike an object store there is no automatic history
  of previous `.jsonl` versions. Snapshot the files (`kubectl cp` out of
  the pod, kept in-cluster or on an operator machine only as long as
  needed) before any manual operation that rewrites them.
- **Backups** are whatever the storage class's retain policy gives you.
  There is no scheduled backup of the PVC today.

The `s3` backend ([specs/behaviors/private-storage.md](../../specs/behaviors/private-storage.md#backends))
remains fully supported and is the path if the private store ever needs to
outlive a single cluster, but **no environment uses it today**. The
`S3_*` variables below are documented for completeness only.

## Environment variables (reference)

See [`.env.example`](../../.env.example) for the exhaustive list with
comments. Production pod gets these mounted:

| Variable | Source | Notes |
|----------|--------|-------|
| `NODE_ENV` | ConfigMap | `production` |
| `PORT` | ConfigMap | `3001` |
| `NODE_OPTIONS` | ConfigMap | `--max-old-space-size=512` — see the comment in `configmap.yaml` for how that was sized |
| `CFP_DATA_REPO_PATH` | ConfigMap | `/app/data` — bare gitdir, backed by an `emptyDir`; re-cloned on every pod boot |
| `CFP_DATA_REMOTE` | **Secret** (`codeforphilly-secrets`) | git URL (ssh in sandbox + prod) |
| `CFP_DATA_BRANCH` | ConfigMap | `published` in sandbox + prod (the data repo has no `main`). `fixture` / `legacy-import` for debug pods |
| `CFP_DATA_RELOAD_SECRET` | **Secret** (`codeforphilly-secrets`) | Shared bearer token for the hot-reload webhook; when unset the `/api/_internal/reload-data` endpoint returns 503. Must match the `CFP_DATA_RELOAD_SECRET` Actions secret in the data repo. See [runbook.md](runbook.md#hot-reload-webhook). |
| `CFP_WEB_DIST_PATH` | ConfigMap | `/app/apps/web/dist` |
| `CFP_SITE_HOST` | ConfigMap (patched per cluster) | Public-facing host: `next.codeforphilly.org` in prod until cutover, `codeforphilly.org` after; `next-v2.codeforphilly.org` in sandbox. Drives the markdown renderer's external-link transform, canonical URLs in email, and the SAML IdP metadata's `SingleSignOnService` endpoint URLs. |
| `SAML_ENTITY_ID` | ConfigMap | Optional. Stable SAML IdP entity ID / assertion `Issuer` (default `https://codeforphilly.org/api/saml/slack/metadata`). Leave unset everywhere Slack should keep trusting the production IdP identity — it deliberately does **not** follow `CFP_SITE_HOST`, so flipping the host at cutover doesn't require re-registering with Slack. Only set it when standing up a separate IdP registration. See [specs/api/saml.md](../../specs/api/saml.md#idp-identity-and-hosts). |
| `POSTMARK_SERVER_TOKEN` | **Secret** (`codeforphilly-secrets`) | Postmark server API token for outbound notifications. When unset, the email notifier falls back to a no-op LoggingNotifier — convenient for dev + tests but means no real emails go out. |
| `POSTMARK_MESSAGE_STREAM` | ConfigMap | Postmark message stream for outbound mail (default `outbound`). Must exist on the server the token belongs to. |
| `CFP_NOTIFICATION_FROM` | ConfigMap | RFC 5322 sender address for outbound notifications (default `"Code for Philly <notifications@codeforphilly.org>"`). Sender domain must be a verified Postmark sender signature (already true for `codeforphilly.org` via the legacy site). |
| `STORAGE_BACKEND` | ConfigMap | `filesystem` in sandbox **and** prod. `s3` is supported but unused. |
| `CFP_PRIVATE_STORAGE_PATH` | ConfigMap | `/app/private-storage` (the PVC mount) |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` | — | Only when `STORAGE_BACKEND=s3`. Not set anywhere today. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | Only when `STORAGE_BACKEND=s3`. Not set anywhere today. |
| `GITHUB_OAUTH_CLIENT_ID` | **Secret** (`codeforphilly-secrets`) | OAuth app client ID (not sensitive, but it ships alongside the secret for one-place rotation) |
| `GITHUB_OAUTH_CLIENT_SECRET` | **Secret** (`codeforphilly-secrets`) | OAuth app client secret |
| `CFP_JWT_SIGNING_KEY` | **Secret** (`codeforphilly-secrets`) | HS256 key (`openssl rand -base64 64`) |
| `SAML_PRIVATE_KEY` / `SAML_CERTIFICATE` | **Secret** (`codeforphilly-saml`, prod) | Slack IdP key pair, carried over verbatim from laddr's `saml2` secret so Slack keeps trusting the same cert. Mounted via an extra `envFrom` patch in the live cluster repo; marked `optional` so a sandbox without it still boots. |
| `SLACK_TEAM_HOST` | ConfigMap | Slack workspace host (default `codeforphilly.slack.com`). ACS URL, NameID `NameQualifier`, `/chat` + `/launch` redirect target. Never our own IdP identity. |
| `GIT_SSH_COMMAND` | ConfigMap | Wires `ssh` to the mounted deploy key |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | ConfigMap | Committer identity for API-authored data commits |

## Rollback

Three distinct rollback flavors:

- **Image / version rollback** — move the two pins in the cluster repo
  (`.holo/sources/codeforphilly-ng.toml` `ref` and
  `codeforphilly-ng/app/kustomization.yaml` `newTag`) back to the previous
  release tag and run it through the deploy PR. For an out-of-band hotfix,
  `kubectl -n <ns> set image deploy/codeforphilly
  codeforphilly=ghcr.io/codeforphilly/codeforphilly-ng:<known-good-tag>`
  and reconcile the repo afterwards. The `Recreate` strategy serializes the
  swap; a few seconds of `503` on the readiness probe is expected while the
  new pod boots.
- **Hostname rollback** (cutover only) — `git revert` the cutover commit in
  `cfp-live-cluster`. See [cutover-rollback.md](cutover-rollback.md).
- **Data rollback** — `git revert` (or `git push --force-with-lease` after
  a careful local rebase) on the data repo's `published` branch. The push
  fires the hot-reload webhook, so the running pod picks it up without a
  restart. Don't conflate the flavors: rolling the image back does not undo
  data writes the API has already pushed, and neither touches the private
  store on the PVC.
