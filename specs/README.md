# Specs

This directory is the source of truth for what `codeforphilly.org` *should be*. The implementation in `apps/` is brought into conformance with these specs — not the other way around.

If you're about to write code, you're in the wrong place. Start here, read the relevant spec, then go write code that matches it.

## Workflow

```
1. Spec change  →  propose what should be true
2. Accept       →  reviewer agrees on desired state
3. Implement    →  bring code into conformance
4. Verify       →  compare running software to spec
```

Concretely:

- **Starting a feature** — write or update the spec files first. Open the PR with the spec changes. Once reviewers agree, implement.
- **Fixing a bug** — if the spec covers the behavior, the spec is right and the code is wrong; fix the code. If the spec is silent, decide whether the spec should be amended.
- **Reviewing code** — compare the diff against the spec. The spec is the acceptance criteria.
- **Spec is ambiguous** — propose a spec amendment in the same PR; don't guess and code.

PRs that change runtime behavior should include a spec change. If they don't, that's a smell.

## Directory layout

```
specs/
├── README.md            # This file — workflow + layout
├── architecture.md      # Tech stack, project structure, foundational decisions
├── data-model.md        # Domain entities, fields, relationships
├── deferred.md          # Features intentionally not in scope (yet)
├── api/                 # One file per endpoint group; conventions.md covers cross-cutting rules
├── screens/             # One file per route — what the user sees, what they can do
└── behaviors/           # Cross-cutting rules referenced from multiple screens/APIs
```

## What specs cover

- **Data requirements** — where data comes from, what fields exist, what's required
- **Display rules** — what appears on the screen, in what order, under what conditions
- **Actions** — what the user can do, what each action causes
- **Navigation** — where a screen links to, what links to it
- **Business rules** — calculations, state machines, validation, authorization
- **API contracts** — request/response shapes, auth, error envelopes

## What specs do NOT cover

- **Visual design** — colors, spacing, typography. That lives in the design system and Tailwind theme.
- **Component decomposition** — how a screen breaks into React components is an implementation choice.
- **Test cases** — tests derive from specs but aren't the spec.
- **File paths, variable names, framework APIs** — implementation details that change freely.

## The right level of detail

Specs declare *what* must be true, not *how* to implement it.

**Good** — declarative, testable:
> "Each project card shows: title (linked), stage badge, README excerpt truncated to 600 characters, member avatars (maintainer largest, ordered by role then alphabetically), and a button row for Public Site / Developers / Chat Channel where each URL is present."

**Too vague** — implementer still has to guess:
> "The project card shows project info."

**Too detailed** — duplicates the code:
> "Map over `project.members.sortBy(m => m.role === 'maintainer' ? 0 : 1).map(...)` and render an `<Avatar size={m.role === 'maintainer' ? 64 : 48}>`..."

## Spec drift auditing

Run `/audit-spec-drift` to launch a comprehensive audit comparing this directory against the implementation. It produces three tables: specified-but-not-implemented, implemented-but-not-specified, and conflicts. Use it before starting major work, after large refactors, and as part of the release checklist.

## Authoring guidance

- Use the templates below. Sections may be empty during early drafts; mark them `_TBD_` rather than deleting them so readers know what's missing.
- Link liberally between specs — `[stages behavior](../behaviors/project-stages.md)`, `[project detail](../screens/project-detail.md)`, etc. Specs form a graph.
- When a screen says "completion fraction" or "help-wanted role", the corresponding behavior spec is canonical. Repeat just enough on the screen spec for it to make sense in isolation; link to the behavior for the full rule.
- Prefer enumerations and tables over prose for anything with discrete cases.

### Screen template

```markdown
# Screen: <Name>

## Route
Path / URL pattern. Auth requirement.

## Data Requirements
What data this screen needs and where it comes from (API endpoint, derived state, query params).

## Display Rules
Declarative description of what appears under what conditions. The reviewer checks the implementation against this.

## Actions
What the user can do and what each action causes (state change, navigation, API call).

## Navigation
Where you can go from here. What links to here.

## Authorization
Who can see what. Variations for anonymous / signed-in / member / staff / admin.
```

### Behavior template

```markdown
# Behavior: <Name>

## Rule
The invariant or rule, stated declaratively.

## Applies To
Which screens, APIs, or entities this behavior governs.

## Details
Edge cases, calculations, timing, error handling.
```

### API template

```markdown
# API: <Name>

## Endpoints
Table of method + path + auth + summary.

## Request / Response
Shapes per endpoint with field types. Reference shared schemas from `data-model.md` rather than re-stating them.

## Errors
Specific failure cases beyond the conventions in `conventions.md`.

## Notes
Caching, idempotency, side effects, related behaviors.
```
