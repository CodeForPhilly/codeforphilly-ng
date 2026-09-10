# Secret management

Every secret consumed by codeforphilly-ng at runtime, how to generate it,
how it gets into the cluster, and how to rotate it.

> See [deploy.md](deploy.md) for how the Deployment consumes these. See
> [specs/architecture.md](../../specs/architecture.md#deploy) for the env-var
> contract this implements.

## Principles

1. **Never in the image.** Secrets are mounted at run-time. The Dockerfile
   carries zero credentials.
2. **Never in git.** Use [sealed-secrets](https://github.com/bitnami-labs/sealed-secrets)
   (cluster default). The plaintext only exists on the machines that
   generated it.
3. **Scoped.** Each secret is granted the minimum surface needed
   (per-namespace, per-environment). No "infra" secret used for multiple
   purposes.
4. **Rotatable.** Every secret in this doc has a rotation procedure that does
   not require a code change.

## Where they live in the cluster

SealedSecrets are committed in the GitOps repo for each cluster and
materialized by that cluster's sealed-secrets controller. Sealed values are
cluster-bound: a Secret sealed for the sandbox cannot decrypt in the live
cluster.

| Cluster | Repo path | Namespace |
| --- | --- | --- |
| Production | `cfp-live-cluster/codeforphilly-ng.secrets/` | `codeforphilly-ng` |
| Sandbox | `cfp-sandbox-cluster/codeforphilly-ng.secrets/` | `codeforphilly-rewrite-sandbox` |

Production has three Secret objects:

| Secret name | Mount mechanism | Holds |
| ------------- | ----------------- | ------- |
| `codeforphilly-secrets` | `envFrom: secretRef` (entire Secret becomes env) | `CFP_JWT_SIGNING_KEY`, `CFP_DATA_REMOTE`, `CFP_DATA_RELOAD_SECRET`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `POSTMARK_SERVER_TOKEN` |
| `codeforphilly-saml` | `envFrom: secretRef` (added by a patch in the live cluster repo, `optional: true`) | `SAML_PRIVATE_KEY`, `SAML_CERTIFICATE` — carried over verbatim from laddr's `saml2` secret |
| `codeforphilly-data-deploy-key` | Volume-mounted, one file (`id_ed25519`) | SSH private key for the data repo |

The sandbox has `codeforphilly-secrets` and `codeforphilly-data-deploy-key`
(no SAML — the sandbox is not registered with Slack).

The first two Secret names are referenced from
`deploy/kustomize/base/deployment.yaml` (`codeforphilly-secrets`, the deploy
key volume) and from the live cluster repo's kustomization patch
(`codeforphilly-saml`); changing them means touching those manifests.

### Adding or changing one key in an existing SealedSecret

Use `kubeseal --merge-into` so you only ever handle the key you're changing
and don't have to re-supply every other value:

```bash
# against the target cluster's kubeconfig
kubectl create secret generic codeforphilly-secrets \
  --namespace codeforphilly-ng \
  --from-literal=POSTMARK_SERVER_TOKEN="$NEW_TOKEN" \
  --dry-run=client -o yaml \
  | kubeseal --controller-name=sealed-secrets --controller-namespace=sealed-secrets \
      --format yaml --merge-into codeforphilly-ng.secrets/codeforphilly-secrets.yaml
```

Commit the updated sealed YAML on a branch in the cluster repo, PR into
`main`, merge the resulting deploy PR. Then `kubectl -n codeforphilly-ng
rollout restart deploy/codeforphilly` — env-mounted Secrets are read at pod
start, not live.

## Inventory

### `CFP_JWT_SIGNING_KEY`

HS256 key for stateless session JWTs.

- **Generate:**

  ```bash
  openssl rand -base64 64
  ```

- **Rotation impact:** every active session is invalidated. Users have to
  sign in again. Plan rotations during low-traffic windows; do not rotate
  during launches.
- **Rotation procedure:** generate new value → `--merge-into` the
  sealed-secret → merge → `kubectl rollout restart` → users re-auth.
- **Cadence:** every 12 months, plus immediately on suspected leak.

### `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`

Credentials for the GitHub OAuth app. Production uses the **org-owned
"Code for Philly"** app (the laddr app was renamed "Code for Philly
(legacy)"). Its callback URL is registered on the apex,
`https://codeforphilly.org/...`; GitHub accepts redirect URIs on subdomains
of the registered callback, so `next.codeforphilly.org` works against the
same app and **nothing changes at cutover**. Use a separate app for the
sandbox.

- **Generate:** GitHub → Organizations → CodeForPhilly → Settings →
  Developer settings → OAuth Apps → "Code for Philly" → "Generate a new
  client secret". GitHub never reveals the old secret again.
- **Client ID:** not sensitive, but it lives in `codeforphilly-secrets`
  next to the secret so the pair rotates in one place.
- **Rotation impact:** in-flight OAuth callbacks fail. Existing sessions are
  unaffected (the secret is only used during the OAuth handshake).
- **Rotation procedure:** issue new secret in GitHub → `--merge-into` →
  merge → `kubectl rollout restart`.
- **Cadence:** every 12 months, plus immediately on suspected leak.

### `CFP_DATA_RELOAD_SECRET`

Bearer token gating `POST /api/_internal/reload-data` (the hot-reload
webhook). The same value must be set as the `CFP_DATA_RELOAD_SECRET`
Actions secret in `CodeForPhilly/codeforphilly-data`, which
`notify-deployments.yml` sends to both sandbox and prod — so today one
value is shared across both environments.

- **Generate:** `openssl rand -hex 32`.
- **Rotation impact:** until both sides match, every `published` push
  fails its notify step (401) and pods serve stale data until restarted.
- **Rotation procedure:** `--merge-into` both cluster repos → merge →
  restart both pods → update the data repo's Actions secret → push a
  no-op to `published` (or re-run the last workflow) to confirm 200s.
- **Cadence:** every 12 months, plus immediately on suspected leak.

### `CFP_DATA_REMOTE`

The data repo's git URL (`git@github.com:CodeForPhilly/codeforphilly-data.git`).
Not itself sensitive — it lives in `codeforphilly-secrets` because the
entrypoint reads it from the same env block. Changing it takes effect on
the next pod start (fresh `emptyDir`, fresh clone).

### `SAML_PRIVATE_KEY` / `SAML_CERTIFICATE`

PEM-encoded key pair that signs SAML assertions for the Slack IdP
integration ([specs/api/saml.md](../../specs/api/saml.md)). In production
these are **the laddr values**, copied from the legacy `saml2` Secret in
the `code-for-philly` namespace, so Slack's existing trust in that cert
carries straight over. Don't regenerate them as part of cutover.

- **Generate (only for a deliberate rotation):**

  ```bash
  openssl req -x509 -newkey rsa:2048 -days 1095 -nodes \
    -keyout saml-private.pem \
    -out saml-certificate.pem \
    -subj "/CN=codeforphilly.org SAML IdP"
  ```

- **Rotation impact:** Slack stops trusting assertions until its IdP config
  is updated with the new cert. **Do not rotate without coordinating with
  the Slack workspace admin.** With SSO set to "optional" a botched
  rotation is recoverable via email magic links.
- **Not a secret, but paired:** `SAML_ENTITY_ID` (ConfigMap, optional) is
  the IdP identity Slack stores alongside this cert. It defaults to
  `https://codeforphilly.org/api/saml/slack/metadata` and must stay stable
  across host changes — see [deploy.md](deploy.md#environment-variables-reference)
  and [specs/api/saml.md](../../specs/api/saml.md#idp-identity-and-hosts).
- **Rotation procedure:**
  1. Generate new key + cert.
  2. Upload the *new cert* to Slack as a secondary signing cert.
  3. `--merge-into codeforphilly-ng.secrets/codeforphilly-saml.yaml` with
     the new key + cert.
  4. Merge → `kubectl rollout restart`.
  5. Test SAML SSO from a clean browser (Slack "Test configuration").
  6. Once verified, remove the old cert from Slack.
- **Cadence:** on cert expiry (check the `notAfter` of the carried-over
  cert — laddr issued it), plus immediately on suspected leak.

### `POSTMARK_SERVER_TOKEN`

Server API token for the [Postmark](https://postmarkapp.com) HTTPS email
API. Drives the email notifier (help-wanted, welcome, password-reset).
When unset, the API falls back to a no-op `LoggingNotifier` — convenient
for local dev but means real users get no outbound mail in production.

- **Generate:** Postmark → the Code for Philly account (the same one the
  legacy site sends through) → Servers → pick or create a server for this
  app → API Tokens → Create token. One server per environment (sandbox
  vs. prod) keeps activity streams and bounces separate.
- **Pre-flight:** the sender domain (`codeforphilly.org`) is already
  verified (SPF + DKIM + Return-Path) in the Postmark account from the
  legacy site; confirm it still shows verified under Sender Signatures
  before flipping this on. The optional `POSTMARK_MESSAGE_STREAM`
  ConfigMap value (default `outbound`) must name a transactional stream
  that exists on the chosen server.
- **Rotation impact:** none in-flight (no in-flight email state on our
  end); next outbound mail uses the new token.
- **Rotation procedure:** create new token in Postmark → `--merge-into` →
  merge → `kubectl rollout restart` → delete the old token in Postmark.
- **Cadence:** every 12 months, plus immediately on suspected leak.

### Data-repo deploy key

SSH ed25519 private key with **write** access to the `codeforphilly-data`
repo on GitHub. Mounted as a file at `/etc/cfp-data-deploy-key/id_ed25519`;
the ConfigMap's `GIT_SSH_COMMAND` points ssh at it.

- **Generate:**

  ```bash
  ssh-keygen -t ed25519 -f cfp-data-deploy -N "" -C "codeforphilly-ng <cluster> deploy"
  ```

  Add the *public* key (`cfp-data-deploy.pub`) to the data repo's
  Settings → Deploy keys with "Allow write access" checked
  (`gh-axi repo deploy-key add ... --allow-write`). One key per cluster.
- **Rotation impact:** the entrypoint's clone fails on the next pod start
  and the push daemon fails to push until the new key is mounted. Reads
  and writes to in-memory state continue; unpushed commits sit in the
  pod's bare clone (and are lost if the pod is recreated before the push
  succeeds — see [runbook.md](runbook.md#fetch-from-the-pods-data-clone)).
- **Rotation procedure:**
  1. Generate new keypair.
  2. Add new public key to the data repo (alongside the existing one).
  3. Re-seal `codeforphilly-data-deploy-key` with the new private key
     (`kubectl create secret generic ... --from-file=id_ed25519=... | kubeseal ...`,
     replacing the file — a single-key Secret doesn't need `--merge-into`).
  4. Merge → `kubectl rollout restart`.
  5. Verify a test mutation reaches the remote.
  6. Remove the old deploy key from the data repo.
- **Cadence:** every 12 months, plus immediately on team turnover or
  suspected leak.

### `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (unused)

Credentials for an S3-compatible private-storage bucket. **No environment
uses the `s3` backend today** — sandbox and production both run
`STORAGE_BACKEND=filesystem` on a PVC ([deploy.md](deploy.md#private-storage)).
If that ever changes: provision the bucket with versioning on, scope an IAM
policy to that single bucket, add the two keys to `codeforphilly-secrets`
and `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` to the ConfigMap, and
migrate the two `.jsonl` files off the PVC. Rotation would follow the
two-key overlap pattern (provision second key → swap → verify → revoke).

## Bootstrapping a new environment

First-time set up of a new namespace (e.g. a second sandbox). Run against
the target cluster's kubeconfig so `kubeseal` fetches that cluster's public
key.

```bash
NS=codeforphilly-ng                 # or codeforphilly-rewrite-sandbox
OUT=~/Repositories/cfp-live-cluster/codeforphilly-ng.secrets

# 1. Namespace (in the cluster repo's namespace.yaml normally; kubectl for a scratch env)
kubectl create namespace "$NS"

# 2. Generate values locally
mkdir -p .secrets
openssl rand -base64 64 > .secrets/jwt
openssl rand -hex 32   > .secrets/reload
ssh-keygen -t ed25519 -f .secrets/deploy -N "" -C "codeforphilly-ng $NS deploy"
# ... GitHub OAuth client id + secret from the GitHub UI, Postmark token from Postmark ...

# 3. Seal
kubectl create secret generic codeforphilly-secrets \
  --namespace "$NS" \
  --from-literal=CFP_JWT_SIGNING_KEY="$(cat .secrets/jwt)" \
  --from-literal=CFP_DATA_RELOAD_SECRET="$(cat .secrets/reload)" \
  --from-literal=CFP_DATA_REMOTE="git@github.com:CodeForPhilly/codeforphilly-data.git" \
  --from-literal=GITHUB_OAUTH_CLIENT_ID="$GH_CLIENT_ID" \
  --from-literal=GITHUB_OAUTH_CLIENT_SECRET="$GH_SECRET" \
  --from-literal=POSTMARK_SERVER_TOKEN="$POSTMARK_TOKEN" \
  --dry-run=client -o yaml \
  | kubeseal --controller-name=sealed-secrets --controller-namespace=sealed-secrets --format yaml \
  > "$OUT/codeforphilly-secrets.yaml"

kubectl create secret generic codeforphilly-data-deploy-key \
  --namespace "$NS" \
  --from-file=id_ed25519=.secrets/deploy \
  --dry-run=client -o yaml \
  | kubeseal --controller-name=sealed-secrets --controller-namespace=sealed-secrets --format yaml \
  > "$OUT/codeforphilly-data-deploy-key.yaml"

# Production only — carry the laddr SAML key pair over rather than minting a new one:
kubectl -n code-for-philly get secret saml2 -o yaml   # inspect key names, then
kubectl create secret generic codeforphilly-saml \
  --namespace "$NS" \
  --from-literal=SAML_PRIVATE_KEY="$(kubectl -n code-for-philly get secret saml2 -o jsonpath='{.data.<key-field>}' | base64 -d)" \
  --from-literal=SAML_CERTIFICATE="$(kubectl -n code-for-philly get secret saml2 -o jsonpath='{.data.<cert-field>}' | base64 -d)" \
  --dry-run=client -o yaml \
  | kubeseal --controller-name=sealed-secrets --controller-namespace=sealed-secrets --format yaml \
  > "$OUT/codeforphilly-saml.yaml"

# 4. Commit the sealed YAMLs in the GitOps repo, PR into main, merge the deploy PR.
# 5. Add the deploy public key to the data repo; set CFP_DATA_RELOAD_SECRET in the data repo's Actions secrets.
# 6. Wipe plaintext
shred -u .secrets/*
```

The sealed `.yaml` files are safe to commit; they can only be decrypted by
the sealed-secrets controller in the matching cluster.

## What's *not* a secret

Listed because operators ask:

- `GITHUB_OAUTH_CLIENT_ID` — public by design; GitHub exposes it during
  every OAuth flow. (Stored in the Secret anyway, for one-place rotation.)
- `CFP_DATA_REMOTE` — URL form. The *access* (deploy key) is secret; the
  URL itself isn't. (Also stored in the Secret; see above.)
- `SAML_CERTIFICATE` (the public cert) is technically published to Slack
  anyway, but we keep it next to the private key for atomic rotation.
- `SAML_ENTITY_ID`, `CFP_SITE_HOST`, `SLACK_TEAM_HOST`, `CFP_DATA_BRANCH` —
  ConfigMap values.
