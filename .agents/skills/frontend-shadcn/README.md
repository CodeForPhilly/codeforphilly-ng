# frontend-shadcn

The Jarvus convention set for building frontends with **Vite + React 19 + shadcn/ui + Tailwind CSS
v4 + React Router v7** — project setup, adding UI components, routing, and styling, the way Jarvus
builds React apps.

## When you'd want it

Any project with this React frontend stack — scaffolding a new app, adding shadcn/ui components,
implementing routing, or styling with Tailwind. Install it on a repo so an agent working on the UI
follows the house conventions (New York style components, the `@tailwindcss/vite` plugin, etc.).

## Install

**Recommended scope: per-project.** This encodes the stack *this* project uses, so installing it in
the repo means every developer (and their agents) gets the same guidance — version-controlled with
the code and updated alongside it.

```bash
npx skills add JarvusInnovations/agent-skills --skill frontend-shadcn
```

(Add `--global` if you'd rather have it available everywhere.) See `SKILL.md` for the stack and patterns
and `references/` for the setup guide and component details.
