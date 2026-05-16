---
status: planned
depends: [storage-foundation]
specs:
  - specs/architecture.md
issues: []
---

# Plan: Deploy

## Scope

Containerization, Helm chart, CI/CD wiring, secret management, the bucket provisioning. Stand up a **staging environment** that the team can hit from outside their laptops. Production deploy follows the same template; pointed at production secrets.

Can start in parallel with the API/web work since this plan exercises just the boot path, but should land **before** [`cutover-prep`](cutover-prep.md) so the actual cutover is just a config flip.

Out of scope: cutover orchestration ([`cutover-prep`](cutover-prep.md)); production data ([`laddr-import`](laddr-import.md)).

## Implements

- [architecture.md](../specs/architecture.md) — the Deploy section's env-var table, the "single Docker image bundles API + static web" claim, the k8s Helm chart story, the bucket-versioning requirement, the data repo's working-tree-on-startup pattern

## Approach

### Dockerfile

`Dockerfile` at the repo root, multi-stage:

1. **Build stage** — `FROM node:22-alpine`, copy lockfile, `npm ci`, copy source, `npm run build`
2. **Runtime stage** — `FROM node:22-alpine`, copy `dist/`, `node_modules` (production only via `npm prune --production`), `package.json`. Install `git` (the API shells out for `git push` via the gitsheets push daemon). Install `ca-certificates`.
3. Entrypoint: a small shell script that:
   - Clones `CFP_DATA_REMOTE` to `CFP_DATA_REPO_PATH` (or pulls if already present)
   - `exec node apps/api/dist/index.js`

Single image serves both API (port 3001) and static `apps/web/dist/` via `@fastify/static`.

### Helm chart

`deploy/charts/codeforphilly/` — modeled on the existing legacy laddr Helm chart but trimmed:

```
deploy/charts/codeforphilly/
├── Chart.yaml
├── values.yaml
├── values.staging.yaml
├── values.production.yaml
└── templates/
    ├── deployment.yaml      # single replica per architecture.md
    ├── service.yaml
    ├── ingress.yaml         # TLS via cert-manager
    ├── pvc.yaml             # for the data repo working tree
    ├── configmap.yaml       # non-secret env
    └── secrets.yaml         # sealed-secrets
```

The Deployment specifies:

- `replicas: 1` (hard constraint per [architecture.md](../specs/architecture.md))
- `strategy.type: Recreate` (no rolling — single replica + write mutex means concurrent old/new replicas would corrupt state)
- Volume mount for the data repo PVC
- Init container or entrypoint command that clones/pulls the data repo

### Sealed secrets

All secrets go through `sealed-secrets` per the legacy cluster's existing pattern. Required secrets:

- `CFP_JWT_SIGNING_KEY` — generated with `openssl rand -base64 64`
- `GITHUB_OAUTH_CLIENT_SECRET` — from the GitHub OAuth App (one app for staging, one for production)
- `SAML_PRIVATE_KEY` + `SAML_CERTIFICATE` — generated with the openssl recipe in laddr's `docs/operations/update-saml2-certificate.md`
- `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` — from whatever bucket provider we end up on
- A deploy key (SSH) for pushing to the data repo (write access only to one branch)

Document each secret's generation + rotation procedure in `docs/operations/secrets.md`.

### Bucket provisioning

The deploy plan picks the production bucket provider. Options:

1. **MinIO inside the cluster** — zero outside dependency; uses cluster's existing storage; cheapest. Adds a small MinIO Helm chart.
2. **Cloudflare R2** — zero egress fees; uses the existing Cloudflare account if Code for Philly has one; pennies per month at our scale.
3. **Backblaze B2** — similar.
4. **AWS S3** — standard; slightly more expensive but most familiar.

Pick at start of this plan. Document the choice. Either way:

- Enable **bucket versioning** (per [behaviors/private-storage.md](../specs/behaviors/private-storage.md))
- IAM policy scoped to the bucket only
- Lifecycle rule deleting non-current versions after 365 days

### GitHub Actions

`.github/workflows/`:

- **`ci.yml`** (exists from [`workspace`](workspace.md)) — runs on PRs: lint, type-check, build, test
- **`deploy-staging.yml`** — runs on merge to `main`: build image, push to ghcr.io, update the staging Helm release via `helm upgrade`
- **`deploy-production.yml`** — runs on git tag push: same flow against production values

Use `actions/checkout@v4`, `docker/login-action@v3`, `azure/setup-helm@v4` (or `azure/setup-kubectl@v4` + raw kubectl). Pin each action version per CLAUDE.md tooling rule (check the action's repo first via `gh-axi repo view`).

### Health checks

`/api/health` (already from [`api-skeleton`](api-skeleton.md)) is the liveness probe. Readiness probe checks `/api/health/ready` — added in this plan, returns 200 only after both stores have loaded.

### Boot order in production

```
1. K8s deployment starts; init container clones CFP_DATA_REMOTE
2. Main container starts; entrypoint validates env via Zod
3. API loads public gitsheets data into memory
4. API loads private store from S3 into memory
5. API builds FTS index
6. API starts the push daemon
7. API binds to port 3001; readiness probe returns 200
8. K8s routes traffic
```

If any step fails: the container exits, k8s restarts it, alert fires.

### Staging vs production

Same image; different values. Staging:

- `codeforphilly-rewrite-staging.k8s.phl.io` (or similar)
- Separate GitHub OAuth App registered with the staging callback
- Separate bucket (or a separate prefix in the same bucket)
- Separate SAML cert (or shared with a different entityID)
- Data repo: a staging-only branch or a separate repo with anonymized data

### Observability

Pino's structured JSON logs go to stdout; k8s log aggregator captures them. Add metrics later if needed. Prometheus scrape config left out of v1 (`pino-prometheus`-style or a `/metrics` endpoint can be added when there's a specific metric we want to alert on).

## Validation

- [ ] `docker build .` produces an image; `docker run` boots the API
- [ ] The same image serves both `/api/*` and the static SPA
- [ ] `helm install` to a staging namespace boots the deployment cleanly
- [ ] Ingress + TLS works (verified by hitting `https://codeforphilly-rewrite-staging.k8s.phl.io/api/health` from outside)
- [ ] The data repo PVC persists across pod restarts (verify by killing the pod and observing the API comes back without re-cloning)
- [ ] The push daemon successfully pushes a test commit to the data remote (using the deploy key)
- [ ] The S3-backed PrivateStore reads/writes against the production bucket; bucket versioning works (verify a PUT increments the version)
- [ ] Readiness probe returns 200 only after both stores load (verify by intentionally pointing at an empty bucket; readiness fails until populated)
- [ ] CI workflows pass and produce deployable artifacts
- [ ] Sealed-secrets in the cluster decrypt and inject correctly
- [ ] Operational docs in `docs/operations/`: secrets management, runbook for "API won't boot", cert rotation

## Risks / unknowns

- **PVC sizing.** The data repo working tree's size depends on history; estimate at ~100MB initial post-import, ~1GB after a few years of activity. 5GB PVC gives plenty of headroom.
- **Deploy key vs GitHub App for push auth.** Deploy key is simpler; GitHub App is more rotateable. Either works. Probably deploy key for v1.
- **Init container vs entrypoint clone.** Init container is k8s-idiomatic but adds a layer. Entrypoint clone is simpler. Either works.
- **Helm chart drift from legacy.** The legacy CFP Helm chart is the reference for cluster conventions. Don't reinvent — copy + adapt.

## Notes
