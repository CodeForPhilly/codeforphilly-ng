# Plans

This directory is the **micro-DAG of work** that bridges `specs/` (timeless: what should be true) to the running code (current: what is). Each plan declares a scope, the specs it implements, its dependencies, and concrete validation criteria.

If `specs/` is the architecture document, `plans/` is the project plan.

## Workflow

Documented in [`.claude/CLAUDE.md`](../.claude/CLAUDE.md#plans). Briefly:

1. Add a plan to start new work. `status: planned` and `depends:` set.
2. Move to `in-progress` when starting, as the first commit on the branch (`chore(plans): mark <slug> in-progress`). Skippable for tiny plans.
3. **Move to `done` as the last commit on the branch, before merge.** That one commit (message: `chore(plans): mark <slug> done (PR #<n>)`) flips frontmatter to `status: done` + `pr: <n>`, ticks each verified validation checkbox, fills in the Notes section, and updates this README's status table (📋 → ✅, name links to the PR). Unverifiable criteria stay `[ ]` with a Notes entry explaining where they'll close out — never rewrite a criterion to match what you ended up doing.
4. After merge: frozen. Historical record, no further edits.
5. A plan implements specs that already exist. If specs need to change mid-plan, the spec change is its own PR before the plan continues.

## Status legend

| Icon | Meaning |
| :-: | --- |
| 📋 | planned |
| 🔨 | in-progress |
| ✅ | done |
| ⛔ | blocked |
| ❌ | cancelled |

## Initial DAG to ship spec-complete

```text
                          workspace
                              │
                              ▼
                          test-harness
                              │
                              ▼
                      storage-foundation
                              │
   ┌─────────────┬──────────┴──────────┬──────────────────────┐
   ▼             ▼                     ▼                      ▼
api-skeleton  web-shell           laddr-import      public-snapshot-scrub
   │             │
   ▼             ▼
auth-jwt-    public-screens (mocked → real)
substrate        │
   │             │
   ├─►───────────┤   (web hits real API once read-api lands)
   ▼             │
read-api ────────┘
   │
   ▼
write-api
   │
   ▼
authoring-screens
   │
   ▼
github-oauth
   │
   ├──────────────────┐
   ▼                  ▼
account-claim     saml-idp
   │
   ▼
 deploy
   │
   ▼
cutover-prep
```

## Status table

| Status | Plan | Implements | Depends on |
| :-: | --- | --- | --- |
| 📋 | [workspace](workspace.md) | architecture.md repo layout | — |
| 📋 | [test-harness](test-harness.md) | — (foundational) | workspace |
| 📋 | [storage-foundation](storage-foundation.md) | data-model, storage, private-storage, markdown-rendering (+ upstream gitsheets: path-templates, transactions, validation, normalization) | test-harness |
| 📋 | [api-skeleton](api-skeleton.md) | api/conventions (+ upstream gitsheets: error taxonomy) | storage-foundation |
| 📋 | [auth-jwt-substrate](auth-jwt-substrate.md) | api/auth (session mgmt only), authorization | api-skeleton |
| 📋 | [read-api](read-api.md) | api/projects + api/people + api/tags + sub-resource GETs, activity-feed, markdown-rendering | api-skeleton |
| 📋 | [write-api](write-api.md) | API mutations across all entities, project-stages, tags, help-wanted-roles, slug-handles | auth-jwt-substrate, read-api |
| 📋 | [web-shell](web-shell.md) | app-shell, login (placeholder) | storage-foundation |
| 📋 | [public-screens](public-screens.md) | home, projects-index, project-detail, people-index, person-detail, help-wanted-index, *-feed, tags, chat, volunteer, sponsor | web-shell |
| 📋 | [authoring-screens](authoring-screens.md) | project-edit, account, write-enabled modals | public-screens, write-api |
| 📋 | [github-oauth](github-oauth.md) | api/auth GitHub flow, account-migration (matching) | write-api |
| 📋 | [account-claim](account-claim.md) | api/account-claim, screens/account-claim, account-migration (claim + merge) | github-oauth |
| 📋 | [saml-idp](saml-idp.md) | api/saml | github-oauth |
| 📋 | [laddr-import](laddr-import.md) | legacy-id-mapping | storage-foundation |
| 📋 | [public-snapshot-scrub](public-snapshot-scrub.md) | storage (dev-data), private-storage (PII rules) | storage-foundation |
| 📋 | [deploy](deploy.md) | architecture deploy sections | storage-foundation |
| 📋 | [cutover-prep](cutover-prep.md) | architecture migration + legacy-id-mapping | every other plan |

## What plans are NOT

- **Not specs.** Specs say what should be true forever; plans say what to do now.
- **Not commits.** A plan produces several commits and typically one PR.
- **Not tickets.** Plans have a dependency graph and validation criteria; tickets are flatter, more granular, and live on GitHub.
- **Not roadmap entries.** A roadmap entry says "we will ship X by Y"; a plan says "here's the scope + how + validation for X."

## After spec-complete

Once the initial DAG completes, plans don't go away — they become the workflow for *every* future feature. New features get a spec change AND a new plan. The plan declares which spec sections it brings to code and how we'll know it's done.

Completed plans stay as historical record. Their merged-PR links + completed-validation criteria are the project's working memory.
