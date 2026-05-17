# Manual sandbox deploy

This is the manual procedure for iterating on a deploy to the **CfP sandbox cluster** (Linode LKE, k8s.phl.io). GitOps wiring is a follow-up; this doc is the source of truth until that lands.

## Cluster

- **Kubeconfig:** `~/.kube/cfp-sandbox-cluster-kubeconfig.yaml`
- **Ingress:** nginx, wildcard DNS for `*.codeforphilly.sandbox.k8s.phl.io` → `45.79.246.168`
- **Storage class:** `linode-block-storage-retain` (default)
- **Sealed-secrets:** controller in `sealed-secrets` namespace
- **cert-manager:** `letsencrypt-staging` + `letsencrypt-prod` ClusterIssuers (staging used here for fast iteration; flip to prod when ready)

## Data repo

The app reads its gitsheets data from a private GitHub repo cloned at boot:

- **Repo:** `git@github.com:CodeForPhilly/codeforphilly-data.git` (private during cutover prep)
- **Branches** — each is an independent data scenario:
  - `fixture` (default) — hand-/import-curated test data, used by sandbox
  - `empty` — sheet configs only, no records
  - `snapshot` — anonymized snapshot of prod (auto-produced post-cutover)
- A read-only **SSH deploy key** mounted into the pod authenticates the entrypoint's clone.

## One-shot deploy steps (manual, while iterating)

```bash
export KUBECONFIG=~/.kube/cfp-sandbox-cluster-kubeconfig.yaml

# 1. Build + push the image
docker build -t ghcr.io/codeforphilly/codeforphilly-rewrite:sandbox .
# NOTE: requires `write:packages` scope on your GitHub token.
# If `docker push` says "token does not match expected scopes":
#   gh auth refresh -s write:packages
docker push ghcr.io/codeforphilly/codeforphilly-rewrite:sandbox

# 2. Apply manifests (creates namespace, sealed-secrets, PVCs, deployment, service, ingress)
kubectl apply -k deploy/kustomize/overlays/sandbox

# 3. Watch the rollout
kubectl -n codeforphilly-rewrite-sandbox rollout status deploy/codeforphilly
kubectl -n codeforphilly-rewrite-sandbox logs -f deploy/codeforphilly
```

After the first successful rollout, the app is live at:

- <https://codeforphilly-rewrite.codeforphilly.sandbox.k8s.phl.io>

## Image visibility

The Docker image is built from this repo and pushed to `ghcr.io/codeforphilly/codeforphilly-rewrite`. For the cluster to pull without an `imagePullSecret`, the package must be **public** on GHCR. After the first push:

1. Visit <https://github.com/orgs/CodeForPhilly/packages/container/codeforphilly-rewrite/settings>
2. Under "Danger Zone" → "Change package visibility" → Public

Until that's done, the deployment will sit in `ImagePullBackOff` with `403 Forbidden`.

## Rotating the deploy key

The SSH deploy key currently in the cluster was generated locally and added to the data repo via `gh repo deploy-key add`. To rotate:

```bash
ssh-keygen -t ed25519 -f /tmp/cfp-deploy-keys/codeforphilly-data-sandbox-rotated -N "" -C "cfp-sandbox-rotated"
gh repo deploy-key add /tmp/cfp-deploy-keys/codeforphilly-data-sandbox-rotated.pub \
  --repo CodeForPhilly/codeforphilly-data \
  --title "cfp-sandbox cluster (rotated $(date +%Y-%m-%d))"
# Then re-seal the secret and re-apply
kubectl create secret generic codeforphilly-data-deploy-key \
  --namespace codeforphilly-rewrite-sandbox \
  --from-file=id_ed25519=/tmp/cfp-deploy-keys/codeforphilly-data-sandbox-rotated \
  --dry-run=client -o yaml \
  | kubeseal --controller-name=sealed-secrets --controller-namespace=sealed-secrets -o yaml \
  > deploy/kustomize/overlays/sandbox/sealed-secret-deploy-key.yaml
kubectl apply -k deploy/kustomize/overlays/sandbox
# Delete the old deploy key from GitHub after the rotation lands cleanly.
```

## Rotating the JWT signing key

```bash
JWT_KEY=$(openssl rand -base64 48)
kubectl create secret generic codeforphilly-secrets \
  --namespace codeforphilly-rewrite-sandbox \
  --from-literal=CFP_JWT_SIGNING_KEY="$JWT_KEY" \
  --from-literal=CFP_DATA_REMOTE="git@github.com:CodeForPhilly/codeforphilly-data.git" \
  --dry-run=client -o yaml \
  | kubeseal --controller-name=sealed-secrets --controller-namespace=sealed-secrets -o yaml \
  > deploy/kustomize/overlays/sandbox/sealed-secret-env.yaml
kubectl apply -k deploy/kustomize/overlays/sandbox
# Rotating the JWT signing key invalidates every issued session — users will
# need to re-auth. Acceptable in sandbox; coordinate before doing this in prod.
```

## Switching data branches

The active branch is set in `deploy/kustomize/base/configmap.yaml` via `CFP_DATA_BRANCH`. To swap:

1. Edit the ConfigMap (or add an overlay patch)
2. `kubectl apply -k deploy/kustomize/overlays/sandbox`
3. `kubectl -n codeforphilly-rewrite-sandbox rollout restart deploy/codeforphilly` — entrypoint re-clones the working tree against the new branch
