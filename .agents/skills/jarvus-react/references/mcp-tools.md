# Documentation and Component Research

Use the documentation and component-discovery tools available in the current agent
environment. Tool names and providers vary, so do not assume a particular MCP server is
installed or hard-code one provider's invocation syntax into the workflow.

## Research Order

1. Inspect the repository's installed versions, lockfile, configuration, and existing
   patterns.
2. Use local type definitions or package documentation when they answer the question.
3. Use an available documentation tool or the library's official documentation for
   version-specific behavior.
4. If the project uses shadcn/ui, use an available registry tool or the official shadcn
   registry to find components and examples.
5. Install only after confirming the package, supported major, and integration steps.

This order prevents current documentation from being applied blindly to an older installed
major and avoids adding dependencies when the repository already has an equivalent.

## Library Documentation

Ask narrow questions that include the installed major and the relevant routing or build
mode. Examples:

- "React Router v7 declarative mode: how does `NavLink` match nested routes?"
- "Tailwind CSS v4 with `@tailwindcss/vite`: how are custom color tokens declared?"
- "MapLibre GL JS installed version: what cleanup does a map instance require?"

Prefer primary sources. Confirm generated examples use the package names and APIs already
present in the repository before copying them.

## shadcn/ui Discovery

Only search the shadcn registry after confirming the project has adopted shadcn/ui or the
user wants to add it. Then:

1. Search the registry for the behavior, not just a component name.
2. Inspect component source and usage examples.
3. Get or construct the exact `bunx --bun shadcn@latest add ...` command.
4. Review the generated diff, including dependencies, `components.json`, theme variables,
   and any overwritten utilities.
5. Run the project's quality checks.

Do not treat registry output as a dependency-free snippet: shadcn components are copied
source that the repository owns after installation.

## If No Research Tool Is Available

Use installed source and official documentation. If network access is unavailable, state
which version-specific point remains unverified rather than guessing. A missing MCP server
is not a reason to block ordinary local implementation work.
