# jarvus-react

The Jarvus convention set for building frontends with **Bun + Vite + React 19 + Tailwind CSS v4 +
React Router v7** — project setup, routing, styling, layout, and the `cn()` helper, the way Jarvus
builds React apps. Bun manages dependencies and runs project scripts. **shadcn/ui is an
optional layer** on top of this base stack (see `references/shadcn.md`), not a default.

## When you'd want it

Use it when a repository already uses this React frontend stack, or when you explicitly want to
bootstrap or migrate to it. Install it on a repo so an agent working on the UI follows the house
conventions (the `@tailwindcss/vite` plugin, pinned `react-router` v7 imports, the `@/` path alias,
and the `cn()` helper) without replacing another package manager, framework, or routing mode by
accident. Adopt shadcn/ui per-project when you want a ready-made component set.

## Install

**Recommended scope: per-project.** This encodes the stack *this* project uses, so installing it in
the repo means every developer (and their agents) gets the same guidance — version-controlled with
the code and updated alongside it.

```bash
npx skills add JarvusInnovations/agent-skills --skill jarvus-react
```

(Add `--global` if you'd rather have it available everywhere.) See `SKILL.md` for the stack and
patterns, `references/setup-guide.md` for bootstrapping, and `references/shadcn.md` for the optional
shadcn/ui layer.
