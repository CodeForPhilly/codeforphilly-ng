# Releases

This repo uses the Jarvus **develop→main Release-PR** flow (the
`JarvusInnovations/infra-components` `release-prepare` / `release-validate` /
`release-publish` composite actions). Versioned releases are cut from a
changelog'd PR; merging it tags the release and publishes the container image.

## The flow

```
feature branch ──▶ develop ──(push)──▶ "Release: vX.Y.Z" PR into main
                                              │ (review changelog, adjust bump)
                                              ▼ (merge)
                                        tag vX.Y.Z ──▶ GHCR image :vX.Y.Z + :latest
```

1. **Merge work into `develop`.** Feature branches PR into `develop` (CI runs on
   `develop` and on every PR). **Only Release PRs ever target `main`** — that's
   what `release-validate` enforces: it fails any PR into `main` whose title
   isn't `Release: vX.Y.Z`, so a stray feature-PR-into-`main` is caught. (The
   one exception is the very first bootstrap PR that introduces these workflows,
   which necessarily merges to `main` directly and trips that check once.)
2. **Push `develop`.** `release-prepare.yml` opens (or updates) a
   **`Release: vX.Y.Z`** PR into `main` with a bot-generated `## Changelog`
   comment. The version is computed from the last `v*` tag + the commits since.
3. **Review the Release PR.** Sort the changelog, confirm the semver bump
   (edit the PR title to override the version if needed — `release-validate.yml`
   keeps it well-formed). Use the **`release-flow`** skill for the changelog +
   bump conventions.
4. **Merge the Release PR.** `release-publish.yml` creates the `vX.Y.Z` tag and
   GitHub release. The tag push triggers `container-publish.yml`, which builds
   and pushes `ghcr.io/codeforphilly/codeforphilly-ng:vX.Y.Z` and `:latest`.
5. **Deploy.** The cluster picks up the image per
   [deploy.md](./deploy.md) (the published `:vX.Y.Z` / `:latest` tags replace
   the previously-manual `:sandbox` build for versioned releases).

## Prerequisites (one-time)

- **`BOT_GITHUB_TOKEN`** repo (or org) secret — a PAT/app token with `repo`
  scope. Required by `release-publish`: a tag pushed with the default
  `GITHUB_TOKEN` cannot trigger `container-publish`, so the image would never
  build.
- **GHCR package write** for Actions — the first `container-publish` run creates
  the package; ensure `github.com/CodeForPhilly/codeforphilly-ng` →
  Packages grants the repo's Actions write access (the workflow uses
  `permissions: packages: write`).
- **Branch protection on `main`** (recommended) — require a PR + green CI to
  merge, so releases only land via the Release PR.

## First release

There are no tags yet, so the first push to `develop` proposes **`v0.1.0`**. If
you want a different baseline, edit the Release PR title before merging.

## Notes

- The manual `docker build --platform=linux/amd64 … :sandbox` path
  ([sandbox-deploy.md](./sandbox-deploy.md)) still works for ad-hoc iteration;
  versioned releases now go through `container-publish` instead.
- CI runners and cluster nodes are both amd64, so `container-publish` needs no
  `--platform` flag (that's only for local Apple-silicon builds).
