# Secret management

Every secret consumed by codeforphilly-rewrite at runtime, how to generate it,
how it gets into the cluster, and how to rotate it.

> See [deploy.md](deploy.md) for how the Deployment consumes these. See
> [specs/architecture.md](../../specs/architecture.md#deploy) for the env-var
> contract this implements.

## Principles

1. **Never in the image.** Secrets are mounted at run-time. The Dockerfile
   carries zero credentials.
2. **Never in git.** Use [sealed-secrets](https://github.com/bitnami-labs/sealed-secrets)
   (cluster default) or a SOPS-encrypted file. The plaintext only exists on
   the machines that generated it.
3. **Scoped.** Each secret is granted the minimum surface needed
   (per-namespace, per-environment). No "infra" secret used for multiple
   purposes.
4. **Rotatable.** Every secret in this doc has a rotation procedure that does
   not require a code change.

## Where they live in the cluster

The Deployment consumes secrets from two Secret objects, both materialized
by the sealed-secrets controller from `SealedSecret` resources committed in
the GitOps repo (`cfp-sandbox-cluster/codeforphilly-ng.secrets/`):

| Secret name | Mount mechanism | Holds |
|-------------|-----------------|-------|
| `codeforphilly-secrets` | `envFrom: secretRef` (entire Secret becomes env) | All env-var secrets |
| `codeforphilly-data-deploy-key` | Volume-mounted, one file | SSH private key for the data repo |

The Secret names are referenced directly from
`deploy/kustomize/base/deployment.yaml`; changing them means touching the
manifest.

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
- **Rotation procedure:** generate new value → update the sealed-secret →
  `kubectl rollout restart deployment/codeforphilly` → users re-auth.
- **Cadence:** every 12 months, plus immediately on suspected leak.

### `GITHUB_OAUTH_CLIENT_SECRET`

Client secret for the GitHub OAuth app. **One app per environment** — a
separate app for staging and production, each with its own callback URL.

- **Generate:** Rotate via the GitHub OAuth app settings page
  (`https://github.com/settings/developers` → app → "Generate a new client
  secret"). GitHub never reveals the old secret again.
- **Companion config:** `GITHUB_OAUTH_CLIENT_ID` is non-secret and lives in
  the ConfigMap (`publicEnv.GITHUB_OAUTH_CLIENT_ID`).
- **Rotation impact:** in-flight OAuth callbacks fail. Existing sessions are
  unaffected (the secret is only used during the OAuth handshake).
- **Rotation procedure:** issue new secret in GitHub → update sealed-secret →
  `kubectl rollout restart`.
- **Cadence:** every 12 months, plus immediately on suspected leak.

### `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`

Credentials for the private-storage bucket. The IAM policy attached to
these credentials must be scoped to the single bucket per
[deploy.md](deploy.md#bucket-provisioning).

- **Generate:** Provider console (R2 → API tokens; B2 → application keys;
  AWS → IAM access key).
- **Rotation impact:** PUTs and GETs to the private store fail until the
  pod is restarted with new keys. Newsletter signups and account claims
  return `private_store_unavailable` (5xx).
- **Rotation procedure:**
  1. Provision a *second* access key in the bucket provider.
  2. Update the sealed-secret with the new value.
  3. `kubectl rollout restart deployment/codeforphilly` — pod boots with
     new keys.
  4. Verify `/api/health/ready` returns 200.
  5. Revoke the old access key in the bucket provider.
- **Cadence:** every 6 months, plus immediately on suspected leak.

### `SAML_PRIVATE_KEY` / `SAML_CERTIFICATE`

PEM-encoded cert chain that signs SAML assertions for the Slack IdP
integration ([specs/api/saml.md](../../specs/api/saml.md)).

- **Generate:** the openssl recipe documented in the legacy repo at
  `laddr/docs/operations/update-saml2-certificate.md`:

  ```bash
  openssl req -x509 -newkey rsa:2048 -days 1095 -nodes \
    -keyout saml-private.pem \
    -out saml-certificate.pem \
    -subj "/CN=codeforphilly.org SAML IdP"
  ```

- **Rotation impact:** Slack stops trusting assertions until its IdP config
  is updated with the new cert. **Do not rotate without coordinating with
  the Slack workspace admin.**
- **Rotation procedure:**
  1. Generate new key + cert.
  2. Upload the *new cert* to Slack as a secondary signing cert.
  3. Update the sealed-secret with the new key + cert.
  4. `kubectl rollout restart`.
  5. Test SAML SSO from a clean browser.
  6. Once verified, remove the old cert from Slack.
- **Cadence:** every 36 months (cert expiry), plus immediately on
  suspected leak.

### `RESEND_API_KEY`

API key for the [Resend](https://resend.com) HTTPS email API. Drives the
help-wanted email notifier. When unset, the API falls back to a no-op
`LoggingNotifier` — convenient for local dev but means real users get no
outbound mail in production.

- **Generate:** Resend dashboard → API Keys → Create API key. Scope to
  send-only on the `codeforphilly.org` sender domain.
- **Pre-flight:** the sender domain (`codeforphilly.org`) must be verified
  in Resend with SPF + DKIM + DMARC records before flipping this on.
  Unverified domains get hard-bounced or spam-filtered immediately.
- **Rotation impact:** none in-flight (no in-flight email state on our
  end); next outbound mail uses the new key.
- **Rotation procedure:** create new key in Resend → update sealed-secret
  → `kubectl rollout restart` → revoke the old key in Resend.
- **Cadence:** every 12 months, plus immediately on suspected leak.

### Data-repo deploy key

SSH ed25519 private key with **write** access to the `codeforphilly-data`
repo on GitHub. Mounted as a file at `/etc/cfp-data-deploy-key/id_ed25519`;
the entrypoint sets `GIT_SSH_COMMAND` to use it.

- **Generate:**

  ```bash
  ssh-keygen -t ed25519 -f cfp-data-deploy -C "codeforphilly k8s deploy"
  ```

  Add the *public* key (`cfp-data-deploy.pub`) to the data repo's
  Settings → Deploy keys with "Allow write access" checked.
- **Rotation impact:** push daemon will fail to push commits until the new
  key is mounted. Reads/writes to the in-memory state continue; the
  inability to push surfaces as a backlog of unpushed commits on the PVC.
- **Rotation procedure:**
  1. Generate new keypair.
  2. Add new public key to the data repo (alongside the existing one).
  3. Update the sealed-secret with the new private key.
  4. `kubectl rollout restart`.
  5. Verify a test mutation reaches the remote.
  6. Remove the old deploy key from the data repo.
- **Cadence:** every 12 months, plus immediately on team turnover or
  suspected leak.

## Bootstrapping a new environment

First-time set up of `codeforphilly-staging` or `codeforphilly`:

```bash
# 1. Create namespace
kubectl create namespace codeforphilly-staging

# 2. Generate all secret values locally
openssl rand -base64 64 > .secrets/jwt
ssh-keygen -t ed25519 -f .secrets/deploy -N ""
# ... GitHub OAuth secret from GitHub UI, S3 keys from R2 console ...

# 3. Build the Secret manifests
kubectl create secret generic codeforphilly-secrets \
  --namespace codeforphilly-staging \
  --from-literal=CFP_JWT_SIGNING_KEY="$(cat .secrets/jwt)" \
  --from-literal=GITHUB_OAUTH_CLIENT_SECRET="$GH_SECRET" \
  --from-literal=S3_ACCESS_KEY_ID="$S3_ID" \
  --from-literal=S3_SECRET_ACCESS_KEY="$S3_KEY" \
  --from-literal=SAML_PRIVATE_KEY="$(cat .secrets/saml-private.pem)" \
  --from-literal=SAML_CERTIFICATE="$(cat .secrets/saml-certificate.pem)" \
  --dry-run=client -o yaml \
  | kubeseal --format yaml > deploy/secrets/staging-secrets.sealed.yaml

kubectl create secret generic codeforphilly-data-deploy-key \
  --namespace codeforphilly-staging \
  --from-file=id_ed25519=.secrets/deploy \
  --dry-run=client -o yaml \
  | kubeseal --format yaml > deploy/secrets/staging-deploy-key.sealed.yaml

# 4. Commit the sealed YAMLs into the GitOps repo
#    (cfp-sandbox-cluster/codeforphilly-ng.secrets/), open a PR.
#    The deploy workflow applies them on merge.

# 5. Wipe plaintext
shred -u .secrets/*
```

The sealed `.yaml` files are safe to commit; they can only be decrypted by
the sealed-secrets controller in the matching cluster.

## What's *not* a secret

Listed because operators ask:

- `GITHUB_OAUTH_CLIENT_ID` — public by design; GitHub exposes it during
  every OAuth flow.
- `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` — public addressing info.
- `CFP_DATA_REMOTE` — URL form. The *access* (deploy key) is secret; the
  URL itself isn't.
- `SAML_CERTIFICATE` (the public cert) is technically published to Slack
  anyway, but we keep it next to the private key for atomic rotation.
