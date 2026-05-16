---
status: planned
depends: []
specs:
  - specs/architecture.md
issues: []
---

# Plan: Workspace scaffold

## Scope

Establish the monorepo skeleton. Empty Fastify and Vite apps that boot. Shared package stub. Toolchain config. CI hello-world. **No business logic; no specs implemented beyond the repo-layout sections.** Everything downstream depends on this.

Out of scope: any actual storage, API endpoints, or UI screens. Those land in dedicated plans.

## Implements

- [specs/architecture.md](../specs/architecture.md) — repo layout, workspace tool choice (npm), TypeScript posture, ESM-only, asdf-managed Node version, conventions section
- [.claude/CLAUDE.md](../.claude/CLAUDE.md) source-control conventions (commit style, lockfile commits, generated-changes-first)

## Approach

1. `npm init` at the root with `workspaces: ["apps/*", "packages/*"]`. Set `"type": "module"`.
2. `asdf set nodejs latest:22` → commits `.tool-versions`. `asdf install`.
3. Create `apps/api/`, `apps/web/`, `packages/shared/` with their own `package.json` per the appropriate skill (`backend-fastify` for api, `frontend-shadcn` for web, plain TS for shared).
4. Root `tsconfig.base.json` with `strict: true`, ESM target. Per-workspace `tsconfig.json` extends base.
5. ESLint flat-config at root, shared across workspaces. Prettier optional — defer unless contributors ask.
6. `.gitignore` covers `node_modules/`, `dist/`, `*.local.*`, `.env*`, the dev `private-storage/` directory (see [behaviors/private-storage.md](../specs/behaviors/private-storage.md)).
7. `apps/api/src/index.ts` boots Fastify on `${PORT:-3001}`, registers a `/api/health` route returning `{status:'ok'}`. No more than 30 lines.
8. `apps/web/src/main.tsx` mounts React, renders "Hello, Code for Philly" at `/`. shadcn init can wait until [`web-shell`](web-shell.md).
9. `packages/shared/src/index.ts` exports nothing useful yet — placeholder.
10. Root `package.json` scripts:
    - `dev` — concurrently run `tsx watch` for api + vite for web
    - `build` — build both workspaces
    - `type-check` — `tsc --noEmit` across workspaces
    - `lint` — `eslint .`
11. `.github/workflows/ci.yml` — checkout, asdf install, `npm ci`, `npm run type-check`, `npm run lint`, `npm run build`. No test step until [`test-harness`](test-harness.md).
12. **Generated changes commit first** per CLAUDE.md: each `npm install <pkg>` call gets its own commit with the command in the body. Manual file edits in separate commits.

## Validation

- [ ] `git clone … && npm install && npm run dev` works on a fresh machine with only asdf preinstalled
- [ ] `curl localhost:3001/api/health` returns `{"status":"ok"}`
- [ ] The web dev server serves the placeholder page at `http://localhost:5173/`
- [ ] `npm run type-check` exits 0
- [ ] `npm run build` produces `apps/api/dist/` and `apps/web/dist/`
- [ ] `.github/workflows/ci.yml` passes on a clean push
- [ ] `package-lock.json` is committed at root
- [ ] No `.js` files in `apps/api/src/` or `apps/web/src/` (TypeScript only)

## Risks / unknowns

- **ESM-only landmines.** Some Fastify plugins still ship CJS-only. Hit them as they come; document the workaround.
- **shadcn init disrupts the file layout.** Deferred to `web-shell`; this plan keeps the web app minimal.
- **asdf vs Volta vs nvm on contributor machines.** CLAUDE.md mandates asdf; CI uses asdf-action. Linux/macOS focus; Windows is best-effort.

## Notes

When plans land use this section to capture decisions / gotchas worth carrying forward.
