# codeforphilly-rewrite

A modernization of [laddr](https://github.com/CodeForPhilly/laddr) — the platform behind [codeforphilly.org](https://codeforphilly.org) — onto a Fastify + Vite/React + [gitsheets](https://github.com/JarvusInnovations/gitsheets) stack.

This site is **spec-driven**: [`specs/`](specs/) declares what should be true and the implementation is brought into conformance with it. Plans in [`plans/`](plans/) are the bridge between specs and code.

## Quick links

- [`specs/README.md`](specs/README.md) — what specs cover, how they're authored, where to start
- [`specs/architecture.md`](specs/architecture.md) — stack, repo layout, deploy
- [`plans/README.md`](plans/README.md) — the work-in-flight DAG that gets us to spec-complete
- [`.claude/CLAUDE.md`](.claude/CLAUDE.md) — authorship conventions, tooling rules, source-control norms

## Getting started

```bash
asdf install
npm ci
npm run dev   # api (:3001) + web (:5173) in parallel
```

Root scripts:

| Command | Effect |
| ------- | ------ |
| `npm run dev` | Concurrent dev servers for `apps/api` + `apps/web` with watch + HMR |
| `npm run build` | Builds every workspace |
| `npm run type-check` | `tsc --noEmit` across all workspaces |
| `npm run lint` | ESLint flat-config at root |

## Stack

- **Backend** — Fastify 5.x + TypeScript, single replica, in-process write mutex
- **Public storage** — gitsheets (TOML records in a git repo, civic-transparency public)
- **Private storage** — S3-compatible bucket (emails, newsletter prefs, legacy password hashes during migration)
- **Frontend** — Vite + React 19 + shadcn/ui + Tailwind v4 + React Router v7
- **Auth** — GitHub OAuth + stateless JWT sessions; we are also the SAML IdP for codeforphilly.slack.com

See [`specs/architecture.md`](specs/architecture.md) for the rationale on each choice.

## Contributing

Spec-first: before writing or changing code, read the relevant spec. If the spec doesn't cover what you're about to do, update the spec first. See [`specs/README.md`](specs/README.md) for the workflow and [`.claude/CLAUDE.md`](.claude/CLAUDE.md) for conventions.
