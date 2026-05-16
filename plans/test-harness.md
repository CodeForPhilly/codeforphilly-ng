---
status: in-progress
depends: [workspace]
specs: []
issues: []
---

# Plan: Test harness

## Scope

Stand up the testing tools every downstream plan will use. Vitest configured per-workspace. Test-repo helper for gitsheets-backed code. Filesystem-backed `PrivateStore` fixture utilities. Mocks for outbound HTTP (GitHub API, Resend, S3).

Out of scope: any actual tests of business logic — they land with the plans that introduce the logic. This plan delivers *the tools*.

## Implements

No spec maps to "we have a working test harness" — testing tools are inherently meta. The plan exists because everything downstream depends on it and the convention should be established up front.

## Approach

1. Install **Vitest** as a dev dependency at root. Each workspace has its own `vitest.config.ts` (the api needs node target; the web needs jsdom).
2. Add an `npm test` script at root that fans out to all workspaces in parallel.
3. Build `apps/api/tests/helpers/test-repo.ts`:
   - `createTestRepo(): Promise<{ repo: Repository, path: string, cleanup: () => Promise<void> }>` — creates a git repo in a `tmp` directory, initializes `.gitsheets/<sheet>.toml` configs from the project's schemas, returns a wired-up gitsheets `Repository`, plus a cleanup callback
   - `seed(repo, fixtures)` — populates the repo from a TypeScript object literal of records
4. Build `apps/api/tests/helpers/test-private-store.ts`:
   - `createTestPrivateStore()` — creates a temp directory, returns a filesystem-backed `PrivateStore` plus cleanup
5. Build `apps/api/tests/helpers/mocks.ts`:
   - A reusable `nock`-style or msw-style mock for `api.github.com` (user lookup, emails endpoint)
   - A no-op Resend mock (collects sends into an in-memory array for inspection)
   - The S3-backed `PrivateStore` backend is covered by the same `PrivateStore` interface; tests use the filesystem backend and assume the S3 backend has its own integration test (deferred until [`deploy`](deploy.md))
6. Web app uses Vitest + React Testing Library against a jsdom environment. `apps/web/tests/test-utils.tsx` provides a `renderWithRouter(element)` helper.
7. CI: add a `test` step to `.github/workflows/ci.yml` running `npm test`.

## Validation

- [ ] `npm test` runs the suite from a fresh clone and passes (with the placeholder test below)
- [ ] One placeholder test per workspace exists and asserts something trivial (`expect(1+1).toBe(2)`) — proves the harness loads
- [ ] `createTestRepo` works end-to-end: create, upsert a record, queryFirst, cleanup
- [ ] `createTestPrivateStore` works end-to-end: putProfile, getProfile, cleanup
- [ ] CI runs tests on push, exits non-zero on a deliberately-broken test (verify via a throwaway PR)

## Risks / unknowns

- **Vitest vs node:test.** Vitest's API is richer + has better watch UX; `node:test` has zero deps. Going with Vitest unless a contributor pushes back — the dev-experience win is real and the dep cost is small.
- **Coverage tooling.** Defer until we hit "what is our coverage?" as a real question. Vitest's `--coverage` works out of the box; no need to wire it now.
- **Parallel test isolation.** `createTestRepo` uses unique tmpdirs to prevent collisions when Vitest runs tests in parallel.

## Notes
