---
status: done
depends:
  - cutover-prep
  - release-flow
  - postmark-notifier
  - saml-self-host
specs:
  - specs/behaviors/account-migration.md
  - specs/behaviors/private-storage.md
  - specs/behaviors/storage.md
  - specs/api/saml.md
issues: []
pr: 172
---

# Plan: Cutover runbook reality check

## Scope

Docs only. Bring `docs/operations/cutover.md` and the operator docs it leans
on (`cutover-rollback.md`, `deploy.md`, `runbook.md`, `secrets.md`,
`legacy-credentials-import.md`, `sandbox-deploy.md`, `monitoring.md`,
`releases.md`, `cutover-announcement.md`, plus the deploy section of
`.claude/CLAUDE.md`) into line with the environments that exist as of
2026-09-10, so the person running cutover is not reading instructions written
before the live cluster, the release flow, or the first data refresh existed.

Out of scope: code changes; spec changes. Spec drift noticed along the way is
recorded under Follow-ups rather than fixed here.

## Implements

No new spec behavior. This plan reconciles operator docs with:

- [behaviors/account-migration.md](../specs/behaviors/account-migration.md) —
  legacy password sign-in persists indefinitely; no dated claim window or
  credential purge exists, so the runbook's T+90 / T+180 sections go.
- [behaviors/private-storage.md](../specs/behaviors/private-storage.md) —
  production runs the `filesystem` backend on a PVC; S3 stays a supported but
  unused backend.
- [behaviors/storage.md](../specs/behaviors/storage.md) — the runtime branch is
  `published` (the data repo has no `main`); hot reload via
  `notify-deployments.yml`.
- [api/saml.md](../specs/api/saml.md) — stable `SAML_ENTITY_ID`, SSO endpoint
  URLs follow `CFP_SITE_HOST`.

## Approach

Facts to encode, each verified against the sibling GitOps / DNS / data clones
on 2026-09-09/10:

- **Environments.** Production is `cfp-live-cluster`, namespace
  `codeforphilly-ng`, pre-cutover host `next.codeforphilly.org`, alongside
  legacy laddr in `code-for-philly`. Sandbox is `cfp-sandbox-cluster`,
  namespace `codeforphilly-rewrite-sandbox`, host `next-v2.codeforphilly.org`.
  There is no separate staging; `cfp-prod-cluster` and
  `codeforphilly-rewrite-staging.k8s.phl.io` never existed under those names.
- **Release + GitOps flow.** `develop` → `Release: vX.Y.Z` PR → tag →
  `container-publish.yml` pushes `ghcr.io/codeforphilly/codeforphilly-ng:vX.Y.Z`.
  Each cluster repo pins the app by `.holo/sources/codeforphilly-ng.toml`
  (`ref`) and `images[].newTag` in `codeforphilly-ng/app/kustomization.yaml`,
  bumped together. Merge to `main` → "Build k8s-manifests" →
  `releases/k8s-manifests` → bot PR into `deploys/k8s-manifests` → merge applies.
  The manual `:sandbox` image push is an escape hatch, not the path.
- **Cutover is a hostname move, not a DNS change.** `codeforphilly.org`,
  `*.codeforphilly.org` and `*.live.k8s.phl.io` already resolve to the live
  cluster's Envoy gateway (managed in `CodeForPhilly/ops` `tf/dns`). T-0 is one
  commit in `cfp-live-cluster` moving the apex + `www` listeners and HTTPRoute
  hostnames from `_gateways/code-for-philly.yaml` to
  `_gateways/codeforphilly-ng.yaml` and flipping the `CFP_SITE_HOST` patch.
  Rollback is `git revert`.
- **Private storage** is a filesystem PVC in prod (`/app/private-storage`).
- **Secrets** live in `cfp-live-cluster/codeforphilly-ng.secrets/` as three
  SealedSecrets: `codeforphilly-secrets`, `codeforphilly-saml` (carried over
  from laddr's `saml2`), `codeforphilly-data-deploy-key`.
- **Slack SAML plan**: SSO optional first, "Test configuration" against the
  `next.codeforphilly.org` metadata, then update only the SSO URL at cutover.
- **Data refresh pipeline**: import → merge `legacy-import` into `published`
  (thousands of deleted-by-us / modified-by-them conflicts for previously
  pruned spam, resolved by taking the import's version) → prune-spam → push,
  which hot-reloads sandbox and prod. First full refresh 2026-09-09/10:
  36,254 imported, 22,625 after prune.
- **Legacy credentials**: export from `emergence-site`.`people` inside the
  laddr pod with the Habitat mysql client; load via `kubectl cp` +
  `rollout restart`. First prod load 2026-09-10: 21,761 profiles/credentials.
- **Monitoring**: nothing external exists yet; say so rather than delete the
  checklist.

## Validation

- [x] `grep -rn 'cfp-prod-cluster\|staging.k8s\|cutover-window-policy\|T+180' docs/ .claude/CLAUDE.md` returns nothing.
- [x] No doc names `main` as a data-repo branch; runtime branch is `published` everywhere.
- [x] No doc gives S3/GCS as the production private-storage path; the filesystem PVC is.
- [x] `cutover.md` T-0 and rollback sections describe the gateway-listener commit and its revert; no DNS/TTL steps remain.
- [x] `legacy-credentials-import.md` export command targets `emergence-site`.`people` via the Habitat client.
- [x] `npm run lint` clean.

## Risks / unknowns

- **Claims not verifiable from the repos** (Slack admin behavior, GitHub OAuth
  app names, MySQL schema details, import counts) are encoded as stated by the
  operator who ran them; flagged in the PR body.
- **Reconcile against production** — the runtime image ships `dist/` only (no
  `tsx`, no `scripts/`), so `script:reconcile` cannot run inside the prod pod,
  and the private store must not be copied to a laptop. Left as a documented
  gap rather than a prescribed workaround.

## Notes

- **Verified from sibling clones, not from memory.** The cluster pins,
  gateway listener names (`https-apex`, `https-www`, `https-subdomain` on
  `code-for-philly`; `https-next` on `codeforphilly-ng`), the three
  SealedSecret names and their keys, the `CFP_SITE_HOST` patch, the
  `Build k8s-manifests` workflow, `notify-deployments.yml`, and the
  `tf/dns` records were all read from local clones of `cfp-live-cluster`,
  `cfp-sandbox-cluster`, `codeforphilly-data-published` and `CodeForPhilly/ops`.
  Anything about Slack admin UI, GitHub OAuth app naming, the MySQL schema,
  or import counts is as reported by the operator who ran it.
- **The runtime image can't run operator scripts.** `Dockerfile` prunes dev
  deps and copies only `dist/`, so `script:reconcile` has no in-pod path and
  the private store can't be copied out to run it locally. `cutover.md`
  names this as an open gap under T+7 instead of prescribing a workaround.
- **`deploy/kustomize/overlays/sandbox/` is now legacy.** The sandbox cluster
  repo carries its own namespace, secrets and hostname patches; the overlay
  in this repo only backs the manual escape hatch. Left in place; removing it
  is a separate decision.
- **The announcement templates were also wrong on passwords.** They told
  members password sign-in "is going away"; fixed alongside the T+90/T+180
  deletions since a member reading them would be misled the same way.
- **`HOST` was dropped from the env table** — it isn't in
  `deploy/kustomize/base/configmap.yaml`; Fastify's default binding is what
  runs.

## Follow-ups

- Spec drift in `specs/architecture.md` (`STORAGE_BACKEND` "`s3` in
  production", entrypoint "`git reset --hard origin/main`",
  `overlays/staging/` + `overlays/production/`) and
  `specs/behaviors/private-storage.md` ("`s3` backend (production)", bucket
  versioning as a production requirement). Both deployed environments run
  `filesystem` on a PVC with no versioning. Needs its own spec PR; not
  touched here because this plan is docs-only.
- `apps/api/scripts/cutover-mailout.ts` template says "Accounts unclaimed
  for one year may be retired" — no spec backs that. Either the sunset spec
  gets written first or the line goes.
- Ship `script:reconcile` (or an equivalent) somewhere it can reach the
  production private store — in the image, or as an in-cluster Job — so the
  T+7 reconciliation check in `cutover.md` is runnable.
- Monitoring: none of `docs/operations/monitoring.md` is wired. First
  post-cutover ops task; the checklist there is the spec for it.
- Consider deleting `deploy/kustomize/overlays/sandbox/` once nobody needs
  the manual escape hatch.
