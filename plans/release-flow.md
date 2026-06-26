---
status: done
depends: []
specs: []
issues: []
pr: 135
---

# Plan: stand up develop→main Release-PR automation

## Scope

Adopt the Jarvus develop→main Release-PR flow so versioned releases are cut from
a changelog'd PR, and the GHCR image build (currently manual) is automated on
tag. Replaces the ad-hoc `docker build/push :sandbox` step for versioned
releases.

What ships:

- **Four workflows** under `.github/workflows/`:
  - `release-prepare.yml` — push to `develop` opens/updates a `Release: vX.Y.Z`
    PR into `main` with a bot changelog (`GITHUB_TOKEN`).
  - `release-validate.yml` — validates that PR as it changes (`GITHUB_TOKEN`).
  - `release-publish.yml` — on merge of that PR, tags `vX.Y.Z`
    (`BOT_GITHUB_TOKEN`, required so the tag can trigger the next workflow).
  - `container-publish.yml` — on `v*` tag, builds + pushes
    `ghcr.io/codeforphilly/codeforphilly-ng:vX.Y.Z` and `:latest`.
- **`ci.yml`** also runs on `develop`.
- **`docs/operations/releases.md`** — operator guide for the flow.
- A `develop` branch created off `main`.

## Implements

No spec — release/CI tooling. Uses the `JarvusInnovations/infra-components`
release-* composite actions (unpinned `channels/.../latest`), matching the
reference repo (`jarvus-data-pipeline`).

## Approach

Adapt the reference workflows to this repo: single image (no sub-image, no
BigQuery), `actions/checkout@v6` + `docker/login-action@v3`, no `--platform`
(CI runners + cluster are both amd64). `BOT_GITHUB_TOKEN` already set as a repo
secret. First release will be seeded at **v0.1.0**.

## Validation

- [x] Four workflows + `ci.yml` (now on `develop`) + `docs/operations/releases.md`
      shipped; YAML parsed by GitHub Actions (the workflows ran on the PR).
- [x] `release-validate` behaves as designed — it ran on PR #135 and failed with
      `PR title must match "Release: vX.Y.Z"`, confirming the guard works (only
      Release PRs may target `main`). Expected on this bootstrap feature-PR.
- [ ] **Activation (post-merge, operator):** create `develop`; first push opens a
      `Release: v0.1.0` PR; merging it tags `v0.1.0` and `container-publish`
      pushes the image. Deferred — see Follow-ups.

## Risks

- `container-publish`'s first run fails if GHCR package write isn't granted or
  `BOT_GITHUB_TOKEN` is missing — non-destructive (tag created, push fails),
  fixable and re-runnable.
- Branch protection on `main` is a GitHub-settings change (operator action).

## Notes

- `release-validate` runs on **every** PR into `main` and fails non-Release PRs
  by design — that's the guard enforcing "only Release PRs target `main`; feature
  work goes to `develop`." Do not be alarmed by its failure on this bootstrap PR.
  Consequently, if branch protection on `main` requires status checks, require
  **`build`** (CI); requiring `release-validate` too would additionally enforce
  the Release-PR-only rule.
- The manual `:sandbox` build path still works for ad-hoc iteration; versioned
  releases now flow through `container-publish`.

## Follow-ups

- **Activation (operator):** after this merges to `main`, create `develop` off
  `main` and push it to open the first `Release: v0.1.0` PR. (I can do this on
  request — held back so the first release is opened deliberately.)
- **Operator (GitHub settings):** confirm `BOT_GITHUB_TOKEN` secret; grant the
  repo's Actions `packages: write` on the GHCR package (first publish creates
  it); add branch protection on `main` (require `build`).
- **Deferred:** wire the cluster/GitOps to track the published `:vX.Y.Z` /
  `:latest` tags instead of the manual `:sandbox` push. No issue filed yet —
  revisit when prod GitOps lands.
