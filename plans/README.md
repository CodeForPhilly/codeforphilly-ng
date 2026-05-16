# Plans

This directory is the **micro-DAG of work** that bridges `specs/` (timeless: what should be true) to the running code (current: what is). Each plan declares a scope, the specs it implements, its dependencies, and concrete validation criteria.

If `specs/` is the architecture document, `plans/` is the project plan.

## Workflow

Documented in [`.claude/CLAUDE.md`](../.claude/CLAUDE.md#plans). Briefly:

1. Add a plan to start new work. `status: planned` and `depends:` set.
2. Move to `in-progress` when starting, as the first commit on the branch (`chore(plans): mark <slug> in-progress`). Skippable for tiny plans.
3. **Move to `done` as the last commit on the branch, before merge.** That one commit (message: `chore(plans): mark <slug> done (PR #<n>)`) flips frontmatter to `status: done` + `pr: <n>`, ticks each verified validation checkbox, fills in **Notes** (decisions and gotchas worth carrying forward), and fills in **Follow-ups** (actionable items not shipped). Unverifiable criteria stay `[ ]` with a Notes entry explaining where they'll close out — never rewrite a criterion to match what you ended up doing. When a Follow-up takes the "Deferred to `<plan>`" shape, the same commit must also edit that downstream plan to absorb the deferral (Approach + Validation) — and the downstream plan must still be `planned`; otherwise file an issue.
4. After merge: frozen. Historical record, no further edits.
5. A plan implements specs that already exist. If specs need to change mid-plan, the spec change is its own PR before the plan continues.

Per-plan frontmatter is the source of truth for both **status** (`status:`) and **graph shape** (`depends:`). This file deliberately does not duplicate either:

- A redrawn DAG or status dashboard would rot the moment anyone forgot to update both.
- To find what's in flight: `grep -l '^status: in-progress' plans/*.md`
- To find what's done: same, with `done`
- To trace dependencies: `grep '^depends:' plans/*.md` or read the plan whose name you care about

## What plans are NOT

- **Not specs.** Specs say what should be true forever; plans say what to do now.
- **Not commits.** A plan produces several commits and typically one PR.
- **Not tickets.** Plans have a dependency graph and validation criteria; tickets are flatter, more granular, and live on GitHub.
- **Not roadmap entries.** A roadmap entry says "we will ship X by Y"; a plan says "here's the scope + how + validation for X."

## After spec-complete

Once the initial DAG completes, plans don't go away — they become the workflow for *every* future feature. New features get a spec change AND a new plan. The plan declares which spec sections it brings to code and how we'll know it's done.

Completed plans stay as historical record. Their merged-PR links + completed-validation criteria are the project's working memory.
