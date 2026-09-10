# Sandbox deploy

The **CfP sandbox cluster** (Linode LKE, `k8s.phl.io`) hosts the rewrite's
sandbox at <https://next-v2.codeforphilly.org>. It plays the "staging" role:
every release is bumped here first and soaks before production.

**Deploys are GitOps.** The
[`cfp-sandbox-cluster`](https://github.com/CodeForPhilly/cfp-sandbox-cluster)
repo pins a release of this repo and applies it; the manual
`docker build … :sandbox && kubectl apply -k` procedure this doc used to
describe is now an emergency escape hatch only (bottom of this page). See
[deploy.md](deploy.md) for the cross-environment picture and
[releases.md](releases.md) for how an image gets published.

## Cluster

- **Kubeconfig:** `~/.kube/cfp-sandbox-cluster-kubeconfig.yaml`
- **Namespace:** `codeforphilly-rewrite-sandbox`
- **Gateway:** Envoy Gateway (`gatewayClassName: eg`). `*.sandbox.k8s.phl.io`
  points at the sandbox LB; `next-v2.codeforphilly.org` is a CNAME onto it,
  managed in `CodeForPhilly/ops` (`tf/dns`).
- **Storage class:** `linode-block-storage-retain` (default)
- **Sealed-secrets:** controller in `sealed-secrets` namespace
- **cert-manager:** `letsencrypt-staging` + `letsencrypt-prod` ClusterIssuers.
  Sandbox uses prod; switch the Gateway annotation to staging for high-churn
  iteration (prod rate-limits to 50 certs/week per registered domain).

## Data repo

The app reads its gitsheets data from `git@github.com:CodeForPhilly/codeforphilly-data.git`
(private), bare-cloned at boot. Branches — each is an independent data scenario:

- `published` (default) — runtime-served in sandbox **and** prod; the merge
  target of `legacy-import`, pruned of confident spam, plus whatever the
  running APIs write. A push here hot-reloads both pods.
- `legacy-import` — raw importer snapshots, spam included.
- `fixture` — small hand-curated test data.
- `empty` — sheet configs only, no records.

A **write** SSH deploy key mounted into the pod authenticates the entrypoint's
clone and the push daemon.

## Deploying a release (the normal path)

In `cfp-sandbox-cluster`, on a branch:

1. Set `ref = "refs/tags/vX.Y.Z"` in `.holo/sources/codeforphilly-ng.toml`.
2. Set `images[].newTag: vX.Y.Z` in `codeforphilly-ng/app/kustomization.yaml`.
3. Commit both together (`chore(codeforphilly-ng): bump to vX.Y.Z`), PR into
   `main`, merge.
4. "Build k8s-manifests" projects the holobranch to `releases/k8s-manifests`;
   a bot opens a PR into `deploys/k8s-manifests`. Merge it — that applies.
5. Watch it land:

   ```bash
   export KUBECONFIG=~/.kube/cfp-sandbox-cluster-kubeconfig.yaml
   kubectl -n codeforphilly-rewrite-sandbox rollout status deploy/codeforphilly
   kubectl -n codeforphilly-rewrite-sandbox logs -f deploy/codeforphilly
   curl -sS https://next-v2.codeforphilly.org/api/health/ready
   ```

Environment-specific bits (Gateway + HTTPRoute for `next-v2.codeforphilly.org`,
the `CFP_SITE_HOST` patch, SealedSecrets) live in the cluster repo under
`_gateways/codeforphilly-ng.yaml`, `codeforphilly-ng/app/kustomization.yaml`
and `codeforphilly-ng.secrets/`. Change them there, not in this repo's
`deploy/kustomize/overlays/sandbox/`.

## Image visibility

The image is built by `container-publish.yml` on every release tag and pushed
to `ghcr.io/codeforphilly/codeforphilly-ng`. For the cluster to pull without
an `imagePullSecret`, the package must be **public** on GHCR:
<https://github.com/orgs/CodeForPhilly/packages/container/codeforphilly-ng/settings>
→ "Change package visibility" → Public. If it ever flips back, the deployment
sits in `ImagePullBackOff` with `403 Forbidden`.

## Rotating the deploy key

The public half is registered on the data repo's deploy-keys page; the
private half is sealed in `cfp-sandbox-cluster/codeforphilly-ng.secrets/codeforphilly-data-deploy-key.yaml`.

```bash
export KUBECONFIG=~/.kube/cfp-sandbox-cluster-kubeconfig.yaml
ssh-keygen -t ed25519 -f /tmp/cfp-deploy-keys/codeforphilly-data-sandbox-rotated -N "" -C "cfp-sandbox-rotated"
gh-axi repo deploy-key add /tmp/cfp-deploy-keys/codeforphilly-data-sandbox-rotated.pub \
  --repo CodeForPhilly/codeforphilly-data --allow-write \
  --title "cfp-sandbox cluster (rotated $(date +%Y-%m-%d))"
kubectl create secret generic codeforphilly-data-deploy-key \
  --namespace codeforphilly-rewrite-sandbox \
  --from-file=id_ed25519=/tmp/cfp-deploy-keys/codeforphilly-data-sandbox-rotated \
  --dry-run=client -o yaml \
  | kubeseal --controller-name=sealed-secrets --controller-namespace=sealed-secrets -o yaml \
  > ~/Repositories/cfp-sandbox-cluster/codeforphilly-ng.secrets/codeforphilly-data-deploy-key.yaml
# Commit in the cluster repo, PR, merge the deploy PR, then:
kubectl -n codeforphilly-rewrite-sandbox rollout restart deploy/codeforphilly
# Delete the old deploy key from GitHub after the rotation lands cleanly.
```

## Rotating the JWT signing key (or any one key in `codeforphilly-secrets`)

Use `kubeseal --merge-into` so the other keys stay untouched — full recipe in
[secrets.md](secrets.md#adding-or-changing-one-key-in-an-existing-sealedsecret).

```bash
export KUBECONFIG=~/.kube/cfp-sandbox-cluster-kubeconfig.yaml
kubectl create secret generic codeforphilly-secrets \
  --namespace codeforphilly-rewrite-sandbox \
  --from-literal=CFP_JWT_SIGNING_KEY="$(openssl rand -base64 48)" \
  --dry-run=client -o yaml \
  | kubeseal --controller-name=sealed-secrets --controller-namespace=sealed-secrets --format yaml \
      --merge-into ~/Repositories/cfp-sandbox-cluster/codeforphilly-ng.secrets/codeforphilly-secrets.yaml
# Commit, PR, merge the deploy PR, rollout restart.
# Rotating the JWT signing key invalidates every issued session — users will
# need to re-auth. Acceptable in sandbox; coordinate before doing this in prod.
```

## Switching data branches

`CFP_DATA_BRANCH` defaults to `published` in `deploy/kustomize/base/configmap.yaml`.
To point the sandbox at another branch, add a ConfigMap patch in
`cfp-sandbox-cluster/codeforphilly-ng/app/kustomization.yaml` (same shape as
the `CFP_SITE_HOST` patch), merge through the deploy PR, then
`kubectl -n codeforphilly-rewrite-sandbox rollout restart deploy/codeforphilly`
— the entrypoint re-clones against the new branch on the fresh `emptyDir`.

## Emergency escape hatch: manual image + apply

Only when the release pipeline or the GitOps repo is itself broken and you
need to get a fix onto the sandbox *now*. Fix the repos afterwards so the
next GitOps apply doesn't revert you.

```bash
export KUBECONFIG=~/.kube/cfp-sandbox-cluster-kubeconfig.yaml

# 1. Build + push a throwaway tag. --platform=linux/amd64 is required on
#    Apple Silicon — the LKE nodes are amd64. Needs `write:packages` on your
#    GitHub token (`gh auth refresh -s write:packages` if push is refused).
docker build --platform=linux/amd64 -t ghcr.io/codeforphilly/codeforphilly-ng:sandbox .
docker push ghcr.io/codeforphilly/codeforphilly-ng:sandbox

# 2a. Point the running Deployment at it without touching manifests...
kubectl -n codeforphilly-rewrite-sandbox set image \
  deploy/codeforphilly codeforphilly=ghcr.io/codeforphilly/codeforphilly-ng:sandbox

# 2b. ...or apply this repo's manual overlay wholesale (namespace, sealed
#     secrets, PVC, deployment, service, gateway). Its sealed secrets are
#     the sandbox ones — they only decrypt on that cluster.
kubectl apply -k deploy/kustomize/overlays/sandbox

# 3. Watch
kubectl -n codeforphilly-rewrite-sandbox rollout status deploy/codeforphilly
```

The `:sandbox` tag is mutable and `imagePullPolicy: Always` in the base
Deployment, so a pod restart picks up a re-push. Never do this against
production.
