# jarvus-release-flow

Drives releases for repos wired with the **Jarvus develop→main Release-PR automation** (the
`JarvusInnovations/infra-components` `release-prepare` / `validate` / `publish` GitHub Actions). The
model is one long-lived `Release: vX.Y.Z` PR from `develop` into `main` — merging it publishes. This
skill gets that PR's version and release notes right, then merges on your go.

## When you'd want it

Whenever you're shipping merged work in such a repo: drafting or editing a `Release: v*` PR, deciding
the semver bump, writing the changelog (sorted into Improvements vs Technical), or merging to
publish. It also triggers the moment it spots a repo with `.github/workflows/release-prepare.yml` or
an open `Release: v*` PR.

## Install

**Recommended scope: per-project.** Cutting releases is an ongoing practice in every repo that uses
the Release-PR flow. Installed in the repo, the skill is version-controlled with the code, so every
contributor's agent follows the same steps, and an update to the skill arrives as a diff the team
can read.

```bash
npx skills add JarvusInnovations/agent-skills --skill jarvus-release-flow
```

Then say "cut a release" / "ship it" in a wired repo and the skill takes over. See `SKILL.md` for how
the automation works and the step-by-step.
