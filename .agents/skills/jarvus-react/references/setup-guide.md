# Vite + React + Tailwind + React Router v7 Stack Setup Guide (Bun)

This guide bootstraps the React base stack on **Bun** — Bun is the runtime, package manager,
and script runner; Vite is the build tool and dev server. shadcn/ui is **optional**; when you
want it, layer it on afterward via [shadcn.md](shadcn.md).

## Contents

- [Prerequisites](#prerequisites)
- [Step-by-Step Setup](#step-by-step-setup)
- [File Structure After Setup](#file-structure-after-setup)
- [package.json Scripts](#packagejson-scripts)
- [VSCode Debugging](#vscode-debugging)
- [Common Issues](#common-issues)

## Prerequisites

- Bun (latest)

### Bun Version Management with asdf

Use [asdf](https://asdf-vm.com/) to manage Bun consistently across the team:

```bash
# Install Bun plugin (one-time setup)
asdf plugin add bun

# Pin Bun for the project (creates .tool-versions)
asdf set bun latest
asdf install
```

The `.tool-versions` file ensures all team members use the same Bun version.

## Step-by-Step Setup

### 1. Initialize Vite Project

```bash
bun create vite . --template react-ts
bun install
```

This creates the current React + TypeScript Vite template. Review the generated dependency
versions and commit the resulting `bun.lock`; do not rely on this guide for a Vite minor
version.

---

### 2. Install Tailwind CSS

```bash
bun add tailwindcss @tailwindcss/vite
```

**Note:** Tailwind v4 uses the `@tailwindcss/vite` plugin instead of a PostCSS config.

---

### 3. Configure Tailwind and Path Aliases

**Install @types/node for path resolution:**

```bash
bun add -d @types/node
```

**Update `vite.config.ts`:**

```typescript
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
```

**Update `src/index.css`** (replace all content). The theme tokens make the base examples
work without shadcn/ui:

```css
@import "tailwindcss";

@theme {
  --color-background: oklch(1 0 0);
  --color-foreground: oklch(0.145 0 0);
  --color-muted: oklch(0.97 0 0);
  --color-muted-foreground: oklch(0.556 0 0);
  --color-border: oklch(0.922 0 0);
}

@layer base {
  body {
    @apply bg-background text-foreground;
  }
}
```

**Add the `@/*` path alias** to `tsconfig.json` (and `tsconfig.app.json` if Vite split the
config). The alias must be present in whichever tsconfig covers `src/`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

---

### 4. Add the cn() Helper

The `cn()` helper merges conditional Tailwind classes. (If you later adopt shadcn/ui, its
`init` writes this same file — see [shadcn.md](shadcn.md).)

```bash
bun add clsx tailwind-merge
```

**Create `src/lib/utils.ts`:**

```typescript
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

---

### 5. Install React Router v7

**IMPORTANT:** React Router v7 uses the package name `react-router`, NOT `react-router-dom`.

```bash
bun add react-router@7
```

Pin the supported major explicitly. An unqualified install may select a newer major with a
different contract.

---

### 6. Set Up React Router

**Update `src/main.tsx`:**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
```

**Update `src/App.tsx`:**

```tsx
import { Routes, Route } from 'react-router'

function App() {
  return (
    <Routes>
      <Route path="/" element={<div>Home</div>} />
    </Routes>
  )
}

export default App
```

**Key imports from `react-router`:**

- `BrowserRouter` - Wrap app in main.tsx
- `Routes`, `Route` - Define routes in App.tsx
- `Link` - Navigation links
- `useLocation` - Get current path
- `useParams` - Get route params
- `useSearchParams` - Get/set query params
- `Outlet` - Render child routes

---

### 7. Create an App Shell

Build a minimal layout by hand with Tailwind + `cn()`. The parent route renders the chrome
and an `<Outlet />`; child routes render inside it.

**`src/components/AppShell.tsx`:**

```tsx
import { NavLink, Outlet } from 'react-router'
import { cn } from '@/lib/utils'

const nav = [
  { to: '/', label: 'Home' },
  { to: '/settings', label: 'Settings' },
]

export function AppShell() {
  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex h-14 items-center gap-4 border-b px-4 lg:px-6">
        <span className="font-semibold">App Name</span>
        <nav className="flex gap-2">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  "rounded px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2",
                  isActive
                    ? "bg-muted font-medium"
                    : "text-muted-foreground hover:bg-muted",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
```

**Wire it into `src/App.tsx`:**

```tsx
import { Routes, Route } from 'react-router'
import { AppShell } from '@/components/AppShell'

function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  )
}
```

> Want a richer, accessible sidebar instead of this hand-built nav? Adopt shadcn/ui and use
> its `sidebar` component — see [shadcn.md](shadcn.md).

---

### 8. Optional: shadcn/ui Component Library

If the project wants a ready-made component set (accessible, Radix-based), layer on
shadcn/ui now. See **[shadcn.md](shadcn.md)** for `bunx shadcn@latest init`, adding
components, and the sidebar-based app shell.

---

### 9. Optional: Add MapLibre GL JS

```bash
bun add maplibre-gl
```

See [maplibre.md](maplibre.md) for a map component. (Remember to import the CSS for proper
styling.)

---

## File Structure After Setup

```
├── src/
│   ├── components/
│   │   └── AppShell.tsx     # Layout (add components/ui/ if using shadcn)
│   ├── hooks/
│   ├── lib/
│   │   └── utils.ts         # cn() helper
│   ├── pages/               # Route components
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css            # Tailwind import (+ theme variables)
├── tsconfig.json
├── tsconfig.app.json        # if Vite split the config
├── vite.config.ts
├── bun.lock                 # committed
└── package.json
```

---

## package.json Scripts

Remove the scaffolded ESLint files only when adopting the Jarvus oxc contract, then
install its tools:

```bash
bun add -d oxlint oxfmt
```

```jsonc
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b",
    "lint": "oxlint src vite.config.ts",
    "format": "oxfmt src vite.config.ts",
    "format:check": "oxfmt --check src vite.config.ts",
    "preview": "vite preview"
  }
}
```

The type-check script is `tsc -b`, not `tsc --noEmit`. The template's root
`tsconfig.json` is `{ "files": [], "references": [...] }` — an empty project that
delegates to `tsconfig.app.json` and `tsconfig.node.json`. `tsc --noEmit` reads that
root, resolves zero input files, and exits 0 even when the app is full of type errors;
references are only followed in build mode. This is why the template's own `build`
script runs `tsc -b`.

The oxc commands take explicit source paths rather than a bare `.`, per the tool
standards in the `jarvus-ci` skill: a bare `.` lints vendored and generated
content, and `oxfmt` formats Markdown by default, so `oxfmt .` rewrites `README.md`
and any docs. Extend the path list if the app grows other TypeScript entry points.

**Format the scaffold once before writing code.** With the scripts in place, run
`bun run format` and commit the result as its own change. The Vite template ships files
that `oxfmt` has never touched, so a pristine scaffold fails `format:check` immediately —
a red gate that reflects the template, not your work. Doing it up front keeps the first
real `format:check` meaningful and keeps formatting churn out of your feature diffs.

The `ui-checks.yml` template from `jarvus-ci` also invokes `bun run test`. Configure
the project's chosen test runner and add a real `test` script before enabling that step,
or deliberately adapt the workflow. Never add a no-op test command.

---

## VSCode Debugging

For client-side React debugging, launch Chrome against the Vite dev server.

**Create `.vscode/launch.json`:**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug in Chrome",
      "type": "chrome",
      "request": "launch",
      "url": "http://localhost:5173",
      "webRoot": "${workspaceFolder}/src",
      "sourceMaps": true
    }
  ]
}
```

1. Start the dev server: `bun run dev`
2. Select "Debug in Chrome" and press `F5`
3. Set breakpoints in React components (`.tsx` files)

The default Vite port is `5173`; `webRoot` maps to `src/` for accurate source-map resolution.

---

## Common Issues

### TypeScript Path Alias Errors

Ensure `baseUrl` and `paths` are in whichever tsconfig covers `src/` (often both
`tsconfig.json` and `tsconfig.app.json`).

### Unused Variable Errors

TypeScript is strict by default. Use a `_varName` prefix for intentionally unused variables.

### React Router Import Errors

Use `react-router` not `react-router-dom` for v7.

### Tailwind Classes Not Working

Ensure `@import "tailwindcss";` is at the top of `index.css` and that every semantic class
used by the app has a corresponding token in `@theme`.
