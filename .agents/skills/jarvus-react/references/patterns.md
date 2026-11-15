# Development Patterns

Base-stack patterns for Bun, Vite, React, Tailwind CSS, and React Router v7. These examples
do not require shadcn/ui. For shadcn components and its sidebar layout, use
[shadcn.md](shadcn.md).

## Contents

- [Project Structure](#project-structure)
- [Routing Architecture](#routing-architecture)
- [URL State](#url-state)
- [Component and Page Design](#component-and-page-design)
- [Accessibility and Responsive Quality](#accessibility-and-responsive-quality)
- [Verification](#verification)

## Project Structure

```text
src/
├── components/       # Shared application components
│   └── AppShell.tsx
├── hooks/            # Custom React hooks
├── lib/
│   └── utils.ts      # cn() and shared utilities
├── pages/            # Route components grouped by feature
├── App.tsx           # Route definitions
├── main.tsx          # Entry point and BrowserRouter
└── index.css         # Tailwind import and theme tokens
```

- Keep route-level components in `pages/` and reusable UI in `components/`.
- Put non-React helpers in `lib/` and reusable hooks in `hooks/`.
- Use the `@/*` alias only after it is configured in Vite and the tsconfig that covers
  `src/`.
- Add `components/ui/` only if the project adopts shadcn/ui.

## Routing Architecture

Follow the router mode already present in the repository. A small browser-routed app can
use declarative routing:

```tsx
// main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
```

Use a layout route and `<Outlet />` instead of repeating application chrome:

```tsx
import { Route, Routes } from 'react-router'
import { AppShell } from '@/components/AppShell'
import { DashboardPage } from '@/pages/dashboard/DashboardPage'
import { SettingsPage } from '@/pages/settings/SettingsPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  )
}
```

Use `NavLink` for navigation state. `end` keeps the root link from matching every nested
route:

```tsx
import { NavLink } from 'react-router'
import { cn } from '@/lib/utils'

<NavLink
  to="/"
  end
  className={({ isActive }) =>
    cn(
      'rounded px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2',
      isActive ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted',
    )
  }
>
  Dashboard
</NavLink>
```

Import v7 APIs from `react-router`, not `react-router-dom`. Prefer router matching APIs
over manual exact comparisons with `location.pathname`, especially for nested routes.

## URL State

Put state in the URL when users should be able to bookmark, refresh, or share it. Typical
examples are search terms, filters, sorting, pagination, and the selected tab.

Read and validate values before using them:

```tsx
const [searchParams, setSearchParams] = useSearchParams()
const environment = searchParams.get('env') ?? 'all'
const page = Math.max(1, Number(searchParams.get('page')) || 1)
```

When updating one parameter, copy the current params so unrelated state survives:

```tsx
function setEnvironment(environment: string) {
  setSearchParams((current) => {
    const next = new URLSearchParams(current)

    if (environment === 'all') {
      next.delete('env')
    } else {
      next.set('env', environment)
    }

    next.delete('page') // the filter changed, so reset dependent pagination
    return next
  })
}
```

Avoid `setSearchParams({ env: 'production' })` when other parameters may exist: replacing
the whole query string can silently discard them.

## Component and Page Design

Keep pages responsible for feature composition and components responsible for reusable
behavior. A page should expose a useful heading hierarchy and explicit UI states:

```tsx
export function ResultsPage() {
  const query = useResults()

  if (query.isPending) return <p role="status">Loading results…</p>
  if (query.isError) return <p role="alert">Could not load results.</p>
  if (query.data.length === 0) return <p>No results match these filters.</p>

  return (
    <section aria-labelledby="results-heading" className="space-y-4 p-4 sm:p-6">
      <h1 id="results-heading" className="text-2xl font-semibold">Results</h1>
      <ResultsList results={query.data} />
    </section>
  )
}
```

For status styles, pair color with text, an icon, or another programmatic cue. Do not make
red, amber, or green the only way to understand a state.

## Accessibility and Responsive Quality

- Prefer native `button`, `a`, `nav`, `main`, `form`, and heading elements.
- Give every control an accessible name; use a visible `<label>` when practical.
- Keep focus visible and verify the interface with a keyboard alone.
- Use ARIA only to fill a semantic gap, not to replace native behavior.
- Provide loading, empty, error, disabled, and success feedback where each applies.
- Start with narrow layouts, then add `sm:`, `md:`, or `lg:` changes when content needs
  them; avoid breakpoint-driven complexity without a layout reason.
- Respect `prefers-reduced-motion` with Tailwind's `motion-reduce:` utilities when adding
  nonessential transitions or animation.
- Avoid assuming light or dark mode exists. Use the project's defined semantic tokens.

## Verification

1. Exercise every changed route directly and through navigation.
2. Refresh and share URLs containing filters or pagination; confirm state is restored.
3. Update one query parameter and confirm unrelated parameters remain.
4. Check keyboard order, visible focus, labels, and status announcements.
5. Check loading, empty, error, disabled, and success states that apply.
6. Test a narrow viewport, a wide viewport, and reduced motion.
7. Run the repository's lint, format check, typecheck, tests, and production build.
