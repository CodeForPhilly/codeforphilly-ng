# shadcn/ui (optional component library)

shadcn/ui is an **optional** layer on top of the [jarvus-react](../SKILL.md) base stack.
It is not a dependency you install — it's a CLI that copies component source into your repo
(under `components/ui/`), which you then own and edit. Reach for it when a project wants a
ready-made, accessible component set (built on Radix + `class-variance-authority`); skip it
when hand-built Tailwind components are enough.

Prerequisites: the base stack from [setup-guide.md](setup-guide.md) — Vite + React +
Tailwind v4 + the `@/` path alias + the `cn()` helper.

## Contents

- [Initialize shadcn/ui](#1-initialize-shadcnui)
- [Add Components](#2-add-components)
- [App Shell with the shadcn Sidebar](#3-app-shell-with-the-shadcn-sidebar)
- [Collapsible Sidebar Sections](#collapsible-sidebar-sections)
- [Status with Badge](#status-with-badge)
- [Common Issues](#common-issues)

## 1. Initialize shadcn/ui

shadcn's CLI detects Bun and uses it. Run it with `bunx`:

```bash
bunx --bun shadcn@latest init --base-color neutral
```

This will:

- Create `components.json`
- Update `src/index.css` with CSS variables and theme
- Create / overwrite `src/lib/utils.ts` with the `cn()` helper
- Install required dependencies (clsx, tailwind-merge, class-variance-authority, etc.) via Bun

**Interactive prompts (if not passing flags):**

- Style: New York
- Base color: Neutral (or your preference)
- CSS variables: Yes

## 2. Add Components

Add components as needed — the CLI copies their source into `components/ui/`:

```bash
bunx --bun shadcn@latest add sidebar -y
bunx --bun shadcn@latest add card button collapsible -y
```

The `sidebar` component pulls in several dependencies automatically (button, separator,
sheet, tooltip, input, skeleton). Review the generated source and dependency diff before
continuing.

Common components:

```bash
bunx --bun shadcn@latest add button card sidebar collapsible dropdown-menu avatar separator sheet tooltip input skeleton badge tabs dialog alert
```

Use an available registry tool or the official shadcn registry to search components and
confirm exact add commands — see
[mcp-tools.md](mcp-tools.md).

## 3. App Shell with the shadcn Sidebar

Once `sidebar` is added, the standard layout:

**`src/components/AppShell.tsx`:**

```tsx
import { Outlet } from 'react-router'
import { SidebarTrigger } from '@/components/ui/sidebar'

export function AppShell() {
  return (
    <div className="flex-1 flex flex-col h-screen bg-background">
      <header className="flex h-14 items-center gap-4 border-b bg-background px-4 lg:px-6">
        <SidebarTrigger />
        <div className="flex-1" />
      </header>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
```

**`src/components/AppSidebar.tsx`:**

```tsx
import { Link, useMatch } from 'react-router'
import {
  Sidebar, SidebarContent, SidebarGroup,
  SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Home } from 'lucide-react'

export function AppSidebar() {
  const isHome = useMatch({ path: '/', end: true })

  return (
    <Sidebar>
      <SidebarHeader className="border-b px-4 py-4">
        <span className="font-semibold">App Name</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={Boolean(isHome)}>
                  <Link to="/">
                    <Home className="mr-2 h-4 w-4" />
                    Home
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
```

**Wire it into `src/App.tsx`:**

```tsx
import { Routes, Route } from 'react-router'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/AppSidebar'
import { AppShell } from '@/components/AppShell'

function App() {
  return (
    <Routes>
      <Route path="/" element={
        <SidebarProvider>
          <AppSidebar />
          <AppShell />
        </SidebarProvider>
      }>
        <Route index element={<HomePage />} />
        <Route path="other" element={<OtherPage />} />
      </Route>
    </Routes>
  )
}
```

## Collapsible Sidebar Sections

```tsx
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDown } from 'lucide-react'

<Collapsible defaultOpen className="group/collapsible">
  <SidebarMenuItem>
    <CollapsibleTrigger asChild>
      <SidebarMenuButton>
        <Icon className="mr-2 h-4 w-4" />
        Section
        <ChevronDown className="ml-auto h-4 w-4 transition-transform group-data-[state=open]/collapsible:rotate-180" />
      </SidebarMenuButton>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <SidebarMenuSub>
        {/* Sub items */}
      </SidebarMenuSub>
    </CollapsibleContent>
  </SidebarMenuItem>
</Collapsible>
```

## Status with Badge

```tsx
<Badge variant="default">Active</Badge>      // Primary color
<Badge variant="secondary">Pending</Badge>   // Muted
<Badge variant="destructive">Error</Badge>   // Red
<Badge variant="outline">Draft</Badge>       // Outlined
```

Keep the status text or another programmatic cue; color alone must not carry the meaning.

## Common Issues

- **Components not styled** — `index.css` must contain the CSS variables that
  `shadcn init` adds; re-run init if they're missing.
- **`cn()` overwritten** — `shadcn init` writes its own `src/lib/utils.ts`. If you already
  had one, reconcile rather than letting init clobber custom helpers.
- **Theme** — projects typically use a light theme only; add `dark:` classes only once dark
  mode is actually implemented.
