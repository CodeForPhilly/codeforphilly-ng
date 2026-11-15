---
name: jarvus-react
description: Build or maintain Jarvus frontend applications that use Bun, Vite, React 19, TypeScript, Tailwind CSS v4, and React Router v7. Use when a repository already uses this stack or when the user explicitly asks to bootstrap or migrate to it; preserve an existing package manager, framework, and routing mode unless migration is requested. shadcn/ui is optional.
---

# Jarvus React

Use this skill for the Jarvus React base stack:

- Bun for dependency management and scripts
- Vite, React 19, and TypeScript
- Tailwind CSS v4 through `@tailwindcss/vite`
- React Router v7 through `react-router`
- `clsx` plus `tailwind-merge` for conditional classes

Treat shadcn/ui as an optional component-library layer. Do not initialize it unless the
project already uses it or the user chooses it.

## Guardrails

1. Inspect the repository before changing dependencies or configuration.
2. Preserve its package manager, framework, routing mode, component system, and quality
   tools unless the user explicitly requests a migration.
3. Use `bun add` in Bun projects; do not hand-edit dependency versions or regenerate a
   lockfile with another package manager.
4. Pin React Router to the supported major with `bun add react-router@7`; an unqualified
   install can move the project to a later major.
5. Keep URL state shareable and preserve unrelated query parameters when updating it.
6. Never commit, push, or publish unless the user has authorized that action.

## Choose the Relevant Reference

| Task | Reference |
|------|-----------|
| Bootstrap the base stack | [setup-guide.md](references/setup-guide.md) |
| Apply routing, URL-state, layout, and accessibility patterns | [patterns.md](references/patterns.md) |
| Add or maintain shadcn/ui | [shadcn.md](references/shadcn.md) |
| Add or debug MapLibre GL JS | [maplibre.md](references/maplibre.md) |
| Research library APIs and components | [mcp-tools.md](references/mcp-tools.md) |

Read only the references needed for the task. For a new project, start with the setup
guide, then open the patterns guide. Open the shadcn or MapLibre reference only when that
layer is in scope.

## Base Conventions

### Imports

```typescript
import { NavLink, Route, Routes, useSearchParams } from 'react-router'
import { cn } from '@/lib/utils'
```

Use `react-router`, not `react-router-dom`, for this v7 stack. Follow an existing
repository's established router mode rather than replacing it automatically.

### Class composition

```typescript
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

### Semantic styling

Base-stack examples use tokens such as `bg-background`, `text-foreground`, `bg-muted`,
and `text-muted-foreground`. Define those tokens in `src/index.css` as shown in the setup
guide. Do not assume shadcn has created them.

## Quality Baseline

For every UI change:

- Use semantic elements and programmatic labels.
- Preserve keyboard operation and visible focus indicators.
- Do not convey status by color alone.
- Cover loading, empty, error, disabled, and success states that apply.
- Check narrow and wide layouts and respect reduced-motion preferences.
- Use `NavLink` or router matching for active navigation instead of exact pathname
  equality when nested routes should remain active.
- Put shareable filters, selections, and pagination in the URL; update a copy of the
  current `URLSearchParams` so unrelated parameters survive.

## Code Quality Contract

Jarvus TypeScript packages use oxc rather than ESLint and Prettier. Remove scaffolded
ESLint only when adopting this contract, then install:

```bash
bun add -d oxlint oxfmt
```

Expose these scripts so local and CI commands agree:

```jsonc
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b",
    "lint": "oxlint src vite.config.ts",
    "format": "oxfmt src vite.config.ts",
    "format:check": "oxfmt --check src vite.config.ts"
  }
}
```

`tsc -b`, not `tsc --noEmit`: the Vite React-TS template's root `tsconfig.json` is an
empty project holding only `references`, so `--noEmit` resolves zero files and exits 0
no matter how broken the code is. Only build mode follows the references.

Scope the oxc commands to real source paths rather than a bare `.`, per the tool
standards in the `jarvus-ci` skill: a bare `.` lints vendored and generated
content, and `oxfmt` formats Markdown by default, so `oxfmt .` rewrites `README.md`
and any docs. Extend the path list if the app grows other TypeScript entry points.

With the scripts in place, run `bun run format` once and commit the result before writing
any code. The Vite template's files were never formatted by `oxfmt`, so a fresh scaffold
fails `format:check` on code you did not write. Formatting once up front means the gate
only ever reports your own changes.

Use the stricter React config and `ui-checks.yml` from the `jarvus-ci` skill. That
workflow also expects a `test` script: configure the repository's chosen test runner
before enabling the test step, or deliberately adapt the workflow. Do not add a fake or
no-op test command merely to make CI green.

## Completion Checks

Run the repository's relevant scripts, normally:

```bash
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run build
```

Skip only commands that genuinely are not configured, and report that limitation. Check
the final diff for unintended dependency, lockfile, generated-file, and formatting
changes.
