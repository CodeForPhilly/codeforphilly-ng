# Workflow internals

The pieces behind the develop→main Release-PR flow. Read this when you need to
**inspect** an existing setup in detail or **scaffold** the automation into a repo
that doesn't have it yet. For day-to-day releasing you don't need this — SKILL.md
covers the procedure.

## The four workflow files

All live in `.github/workflows/`. The three `release-*` ones delegate to pinned
channels of `JarvusInnovations/infra-components`; `ci.yml` is the repo's own build/test.

### `release-prepare.yml`

```yaml
name: 'Release: Prepare PR'
on:
  push:
    branches: [ develop ]
permissions:
  contents: read
  pull-requests: write
jobs:
  release-prepare:
    runs-on: ubuntu-latest
    steps:
    - uses: JarvusInnovations/infra-components@channels/github-actions/release-prepare/latest
      with:
        github-token: ${{ secrets.GITHUB_TOKEN }}
        release-branch: main
```

On every push to `develop`: ensures a single open `Release: vX.Y.Z` PR into
`release-branch`, and posts/updates the bot `## Changelog` comment.

The PR title is computed **once, at PR creation**: `git describe --tags` for the last
tag, then patch-increment its final number. No commit analysis. Subsequent pushes
update only the changelog comment — never the title or body, so edits you make to
either are never clobbered.

**Token variant.** A PR created with the default `GITHUB_TOKEN` cannot trigger other
workflows — GitHub suppresses workflow events for actions taken with that token — so
`release-validate` will **not** run on the bot-created PR until someone edits it.
Repos that want validate green from the start pass the bot token to prepare too:

```yaml
        github-token: ${{ secrets.BOT_GITHUB_TOKEN }}
```

Trade-off: `GITHUB_TOKEN` is least-privilege but the first validate run only happens
after your first title/body edit (or a `develop` sync); `BOT_GITHUB_TOKEN` makes
validate fire immediately at the cost of using the PAT/app token in one more place.

**Custom PR body template.** If the repo has a `.github/release-pr-template.md`,
prepare uses it for the new PR's body; otherwise the body is a near-empty default
(bare `## Improvements` / `## Technical` headers). Since validate never inspects the
body, that default looks deceptively publish-ready — prefer a template that fails
obviously when unedited, e.g. one starting with `<!-- DRAFT: replace before merging -->`.

### `release-validate.yml`

```yaml
name: 'Release: Validate PR'
on:
  pull_request:
    branches: [ main ]
    types: [ opened, edited, reopened, synchronize ]
jobs:
  release-validate:
    runs-on: ubuntu-latest
    steps:
    - uses: JarvusInnovations/infra-components@channels/github-actions/release-validate/latest
      with:
        github-token: ${{ secrets.GITHUB_TOKEN }}
```

Re-runs on every edit to the PR (including title/body edits you make). Exactly two
checks: the PR title matches `^Release: v\d+\.\d+\.\d+(-rc\.\d+)?$`, and the tag in
the title does not already exist. Nothing else — **the body is not inspected**.

Note the trigger has no title filter: this fires on **every** PR into `main`, so a
non-release PR (e.g. a hotfix) shows a red title check by design. Don't retitle such
a PR to appease it.

### `release-publish.yml`

```yaml
name: 'Release: Publish PR'
on:
  pull_request:
    branches: [ main ]
    types: [ closed ]
jobs:
  release-publish:
    runs-on: ubuntu-latest
    steps:
    - uses: JarvusInnovations/infra-components@channels/github-actions/release-publish/latest
      with:
        github-token: ${{ secrets.BOT_GITHUB_TOKEN }}
```

Fires when the PR closes. On a *merged* close it cuts the tag and publishes at the
title's version, with the PR body passed **verbatim** as the release notes — taken
from the closed-PR webhook payload, so a body edited seconds before merge can race
the payload. A title ending `-rc.N` publishes with `prerelease: true`. Note it uses
`BOT_GITHUB_TOKEN` (a PAT/app token), not the default `GITHUB_TOKEN` — publishing
usually needs to push tags/trigger downstream workflows that `GITHUB_TOKEN` can't.

### `ci.yml` (illustrative — language-specific)

```yaml
name: CI
on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main, develop ]
permissions:
  contents: read
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v6
    # ...toolchain setup (node/bun/python/etc.)...
    - run: <install>
    - run: <build>
    - run: <test>
```

Independent of the release actions but must be green on the Release PR like any check.

## npm publishing

Repos that publish to npm typically also have a `publish-npm.yml` invoked by the
publish step (or `release-publish` handles it directly). Trusted Publishing (OIDC,
no token) is the preferred path — configured on npmjs.com by linking the repo +
the publishing workflow. A first-ever publish sometimes needs a manual bootstrap
(`npm publish`) before Trusted Publishing can take over for subsequent automated releases.

## Detecting / verifying a setup

```sh
# Which release workflows exist?
ls .github/workflows/ | grep -E 'release-(prepare|validate|publish)'

# Confirm they point at infra-components and on what branches:
grep -rE 'infra-components|branches:|release-branch' .github/workflows/release-*.yml

# Is there an open Release PR right now?
gh pr list --state open --json number,title | jq '.[] | select(.title|startswith("Release: v"))'
```

## Scaffolding into a new repo

To add this flow to a repo that doesn't have it: create the three `release-*.yml`
files above (adjusting `release-branch` if not `main`), add a `ci.yml` for the repo's
stack, and ensure `BOT_GITHUB_TOKEN` is set in repo/org secrets for `release-publish`.
Pin the infra-components refs to the `.../latest` channels as shown, or to a specific
version if the org standardizes one. Always confirm the current recommended channel/ref
before writing — read the infra-components repo (e.g. `gh-axi repo view
JarvusInnovations/infra-components`) rather than assuming.
