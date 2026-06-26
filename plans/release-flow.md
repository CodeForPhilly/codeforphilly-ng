---
status: in-progress
depends: []
specs: []
issues: []
pr:
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

- [ ] `develop` branch exists on origin.
- [ ] Pushing `develop` opens a `Release: v0.1.0` PR into `main` with a changelog.
- [ ] Merging that PR tags `v0.1.0` and `container-publish` pushes the image to GHCR.
- [ ] YAML is valid (lint / Actions parses it).

## Risks

- `container-publish`'s first run fails if GHCR package write isn't granted or
  `BOT_GITHUB_TOKEN` is missing — non-destructive (tag created, push fails),
  fixable and re-runnable.
- Branch protection on `main` is a GitHub-settings change (operator action),
  not in this repo.

## Notes

## Follow-ups
