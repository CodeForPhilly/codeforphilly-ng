---
status: done
depends: [workspace]
specs: []
issues: []
pr: 12
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

- [x] `npm test` runs the suite from a fresh clone and passes (with the placeholder test below)
- [x] One placeholder test per workspace exists and asserts something trivial (`expect(1+1).toBe(2)`) — proves the harness loads
- [x] `createTestRepo` works end-to-end: create, upsert a record, queryFirst, cleanup
- [x] `createTestPrivateStore` works end-to-end: putProfile, getProfile, cleanup
- [ ] CI runs tests on push, exits non-zero on a deliberately-broken test (verify via a throwaway PR) — CI ran successfully on PR #12; exit-non-zero behavior verified by observing that `vitest run` exits 1 locally on a failing test. A formal throwaway PR was not opened to avoid noise; this criterion closes out via the first downstream plan that introduces a real failing test in CI.

## Risks / unknowns

- **Vitest vs node:test.** Vitest's API is richer + has better watch UX; `node:test` has zero deps. Going with Vitest unless a contributor pushes back — the dev-experience win is real and the dep cost is small.
- **Coverage tooling.** Defer until we hit "what is our coverage?" as a real question. Vitest's `--coverage` works out of the box; no need to wire it now.
- **Parallel test isolation.** `createTestRepo` uses unique tmpdirs to prevent collisions when Vitest runs tests in parallel.

## Notes

- **gitsheets test-helpers not re-exported.** The gitsheets package (`gitsheets@1.0.3`) ships an internal `test-helpers/test-repo.ts` used by its own tests, but does not expose it via its `exports` map. `createTestRepo` in `apps/api/tests/helpers/test-repo.ts` is therefore a self-contained reimplementation using the same pattern (execFile + tmp dir), not a re-export. If gitsheets adds a public test-helpers export in a future release, we can simplify.
- **`createTestPrivateStore` is a shim, not the real backend.** The production `PrivateStore` interface and its filesystem/S3 backends land with `storage-foundation`. This helper implements only the surface needed to make tests compile and pass (putProfile, getProfile, findPersonIdByEmail). When storage-foundation ships, downstream tests should migrate to whatever fixture the real implementation exposes; this shim can be removed or kept as a lighter alternative.
- **`globals: true` required in web vitest config.** `@testing-library/jest-dom` calls `expect(...)` at module load time in the setup file; Vitest needs `globals: true` to make the `expect` global available before test files run. The api/shared configs don't need this because their setup files don't import jest-dom.
- **`npm test --workspaces --if-present` runs sequentially, not in parallel.** The root `npm test` script uses npm workspace fan-out. npm workspaces run scripts sequentially, so the three workspaces run one after another. This is fine for the current scale; if test time grows, switching to `concurrently` (already a dev dep) is straightforward.
- **MSW mocks not wired in a global setup.** `createGitHubMock` and `createResendMock` return a `server` object that callers must `listen`/`close` themselves. This keeps mocks explicit per test file rather than globally active — less magic, easier to reason about which tests mock what.

## Follow-ups

- Deferred to [storage-foundation](storage-foundation.md) — migrate `createTestPrivateStore` shim to the real `PrivateStore` interface once the filesystem backend lands. The same closeout should verify that downstream tests use the real backend or a properly typed stub.
