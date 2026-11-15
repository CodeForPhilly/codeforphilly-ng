---
name: jarvus-release-flow
description: >-
  Cut a release in a repo that uses the Jarvus develop→main Release-PR automation
  (the JarvusInnovations/infra-components release-prepare/validate/publish GitHub Actions).
  Use this whenever you're shipping merged work to production, drafting or editing a
  "Release: vX.Y.Z" PR, deciding a version bump, writing release notes/changelog, or the
  user says "ship it", "cut a release", "publish", "do the release", "merge the release PR",
  or "release notes". Also use it the moment you notice a repo has
  `.github/workflows/release-prepare.yml` (or release-publish/release-validate) or an open
  PR titled "Release: v*" — that's the signal this workflow is in effect. Covers: pushing
  develop to open the Release PR, pulling the bot-generated changelog, sorting commits into
  Improvements vs Technical, recommending semver bump, and merging to publish.
---

# Release flow (develop → main, automated Release PR)

This skill drives releases for repos wired with the **JarvusInnovations/infra-components**
release actions. The whole model is a single long-lived Release PR from `develop`
into `main`; merging it publishes. Your job is to get that PR's **title (version)**
and **body (release notes)** right, then merge it on the user's go.

## How the automation works

Three GitHub Actions, each triggered by a different event — you don't run them, you
react to them:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `release-prepare` | push to `develop` | Opens the **`Release: vX.Y.Z`** PR into `main` and posts/refreshes a bot **`## Changelog`** comment listing the commits since the last release with `@author` suffixes. The title is computed **once, at PR creation**, as last tag + patch increment — no commit analysis — and later pushes never recompute it (they only refresh the changelog comment). |
| `release-validate` | PR to `main` opened/edited/synced | Gates the Release PR with **exactly two checks**: title matches `^Release: v\d+\.\d+\.\d+(-rc\.\d+)?$`, and that tag doesn't already exist. **The body is not checked.** Re-runs every time you edit the PR. |
| `release-publish` | Release PR **closed/merged** | Cuts the tag and publishes (npm, etc.) at the version in the PR title, with the merged PR body **verbatim** as the release notes. **Merging is the publish.** |

`ci.yml` (build + test on push/PR to main and develop) runs orthogonally and must be
green like any other check.

Key consequences for how you work:

- **You never invent the changelog.** The bot comment is the source of truth for which
  commits are in the release and how they're attributed. Pull it, don't reconstruct it
  from `git log` (you'll miss the `@author` suffixes and risk a different commit set).
- **Editing the PR re-triggers `release-validate`.** After you change the title or body,
  give it a few seconds and confirm the latest validate run is green before telling the
  user it's ready.
- **The bot's title is always last-tag + patch.** `release-prepare` does no commit
  analysis and never revisits the title after creation — recomputing the bump from the
  changelog and retitling is *always* your job (step 6), not an occasional correction.
- **Title and body are safe to draft early.** Later `develop` pushes only refresh the
  changelog comment; nothing you write in the title or body ever gets clobbered.
- **The body is not gated.** `release-validate` checks only the title and tag — a PR
  whose body is still the default near-empty template validates green and, once merged,
  ships that template verbatim as the release notes. Getting the body right before
  merge is entirely on you.

## Detecting that this workflow is in effect

Before assuming this skill applies, confirm the repo actually uses it:

```sh
ls .github/workflows/ | grep -E 'release-(prepare|validate|publish)'
gh pr list --state open --json number,title | jq '.[] | select(.title|startswith("Release: v"))'
```

Either signal — a `release-prepare.yml` (or sibling) workflow, or an open `Release: v*`
PR — means this is the flow. If neither is present, this skill doesn't apply; fall back
to the repo's own release docs.

## The procedure

### 1. Find (or open) the Release PR

```sh
gh pr list --state open --json number,title | jq '.[] | select(.title|startswith("Release: v"))'
```

- **PR exists** → work with it (steps 2+).
- **No PR, but `develop` has unreleased commits** → the PR is opened by pushing `develop`.
  Confirm there's unpushed/unreleased work (`git log origin/main..develop --oneline`),
  then `git push origin develop` and wait for `release-prepare` to open the PR. Pushing
  is non-destructive — it only opens a PR for review; it does **not** publish.
- **No PR and nothing unreleased** → tell the user there's nothing to release.

### 2. Read the current PR state

```sh
gh pr view <number> --json title,body,number,url,baseRefName,headRefName
```

### 3. Pull the bot changelog (source of truth)

```sh
gh api repos/{owner}/{repo}/issues/<number>/comments \
  --jq '.[] | select(.body | contains("## Changelog")) | .body'
```

Parse the commit lines from inside the fenced code block. Keep each line **exactly** as
written, including the `@username` suffix. If there's no such comment yet, `release-prepare`
may still be running — wait and retry before falling back to `git log origin/main..develop`.

### 4. Sort commits into two sections

Decide each line by **who cares about the change**, not just the commit type:

- **Improvements** — user/stakeholder-facing capabilities and significant user-facing
  fixes. Things that matter to people who *use* the thing, not just build it.
- **Technical** — everything else: CI/CD, refactors, docs, internal tooling, chores.
  Note `feat(ci)`, `feat(exp)` and similar developer-scoped `feat`s are Technical, and
  `docs` commits are Technical (developer-facing). Type is a signal; scope + description
  decide it.

Omit a section that has no commits (no empty headers).

### 5. Draft the release notes

```
Optional one-sentence headline (write one if the improvements warrant it; omit for a purely technical release)

## Improvements

- <commit line, verbatim, with @author>
- <commit line>

## Technical

- <commit line>
- <commit line>
```

### 6. Recommend a version bump

Read the current version from the PR title, then apply semver against what's actually in
the changelog:

- **Minor** (`v1.0.x → v1.1.0`) — there are real user-facing **Improvements** (a new
  command, feature, or capability). This is the common case when `feat` commits land.
- **Patch** (`v1.0.0 → v1.0.1`) — only fixes/technical/chore work; nothing new for users.
- **Major** (`v1.x → v2.0.0`) — a breaking change (commit body notes `BREAKING CHANGE`,
  or you know the public surface broke). Confirm with the user before recommending major.

State your reasoning in one line. **Always recompute — this is not optional.** The
bot's pre-filled title is mechanically last-tag + patch, computed once at PR creation
with no commit analysis; it is never the product of judgment. Recompute the bump
yourself from the changelog (feats ⇒ minor, breaking ⇒ major) and retitle whenever
your answer differs.

An rc title is also valid: `Release: vX.Y.Z-rc.N` passes validation and publishes as a
GitHub **prerelease**. Use it to cut a candidate before the final `vX.Y.Z`, which then
goes through this same flow.

### 7. Present the draft and get the call

Show the user: the formatted notes, your version recommendation + why, and the PR URL.
Ask whether to **approve as-is**, **edit**, or **change the bump**. Merging publishes, so
the merge is always the user's explicit go — never merge unprompted.

### 8. On approval — apply and merge

```sh
# Body (always); title whenever your recomputed version differs from the current title
gh pr edit <number> --body-file <notes-file>
gh pr edit <number> --title "Release: v<version>"
```

Editing re-triggers `release-validate` — wait a few seconds, confirm it's green:

```sh
gh run list --workflow=release-validate.yml --limit 1 --json status,conclusion
```

Then merge to publish:

```sh
gh pr merge <number> --merge
```

`release-publish` fires on merge. Watch it through and confirm the published artifact
(e.g. `npm view <pkg> version`, or the new tag/GitHub release) before declaring done.

Then verify the release notes actually landed:

```sh
gh release view v<version> --json body --jq .body
```

If the body is the unedited template (bare `## Improvements` / `## Technical` headers),
fix it: `gh release edit v<version> --notes-file <notes-file>`. One residual race to
know about: `release-publish` reads the body from the closed-PR webhook payload, so a
body edited seconds before the merge can lose the race. Avoid last-moment body edits —
finalize the body, confirm validate is green, *then* merge.

## Notes and gotchas

- **Use `gh-axi` if available** (a token-efficient `gh` wrapper); otherwise plain `gh`.
  Either works — the API calls are the same.
- **Write the body from a file** (`--body-file`) rather than a giant inline `--body` —
  multi-line markdown survives intact and you avoid shell-quoting accidents.
- **`main` can look "behind" the latest tag.** Some setups tag a CI bump commit that never
  lands on the `main` branch ref. It looks odd but doesn't block: `release-prepare`
  computes the default title from the last tag alone (`git describe --tags` + patch
  increment) regardless. Flag it to the user as a known quirk, not a blocker.
- **`release-validate` fires on *every* PR into `main`** — the workflow trigger has no
  title filter. A hotfix PR to `main` shows a red "PR title must match format" check by
  design. Don't "fix" it by retitling a non-release PR; the red check is expected there.
- **A red `release-validate` after the tag already exists is usually benign** — it's a
  re-run reporting "version already exists" after a successful publish. Check *when* it
  ran relative to the merge before treating it as a real failure.
- **A repo can override the default PR body template** via `.github/release-pr-template.md`
  (see `references/workflow-internals.md`). Prefer one that fails obviously when
  unedited — e.g. a `<!-- DRAFT: replace before merging -->` sentinel — since the
  default near-empty template looks deceptively publish-ready.
- See `references/workflow-internals.md` for the workflow file shapes and the
  infra-components action refs, when you need to inspect or set up the automation itself.
