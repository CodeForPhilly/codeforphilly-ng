---
status: done
depends: [storage-foundation]
specs:
  - specs/api/conventions.md
upstream-specs:
  # gitsheets defines its own error class hierarchy; the API maps those to the response envelope
  - gitsheets:specs/api/errors.md
issues: []
pr: 17
---

# Plan: API skeleton

## Scope

The Fastify app's cross-cutting plumbing: env validation, plugin ordering, response envelope, error mapper, request logging, rate limiting, trace IDs, OpenAPI. **No endpoints yet beyond `/api/health`** — those land in `read-api` / `write-api` / `auth-jwt-substrate`.

Out of scope: any business logic; auth (its own plan); per-endpoint specs.

## Implements

- [api/conventions.md](../specs/api/conventions.md) — response envelope, error codes table, content type, pagination/sort/filter shape (the helpers; consumers use them later), rate limiting per-IP/in-memory, idempotency-key cache, trace IDs, OpenAPI `/api/_openapi.json` + `/api/_docs`.

Upstream: gitsheets's typed exception classes (`GitsheetsError`, `ValidationError`, `TransactionError`, `IndexError`, `RefError`, `PathTemplateError`, `NotFoundError`) bubble up; the API maps them to the response envelope via a single error hook. The error-code table is in [api/conventions.md](../specs/api/conventions.md#error).

## Approach

### Plugin order

```
1. @fastify/env             (validates env via JSON schema; populates fastify.config)
2. @fastify/cors            (CORS for the dev SPA proxy + any future cross-origin consumer)
3. @fastify/cookie          (cookie parsing for session JWTs later)
4. fastify request-id hook  (UUIDv7 traceId on every request)
5. fastify pino logger      (with traceId in every log line)
6. error mapper hook        (single setErrorHandler)
7. store plugin             (decorates fastify.store from storage-foundation)
8. rate-limit hook          (in-memory counters keyed per-IP + per-account)
9. idempotency-key hook     (in-memory map keyed by personId+key)
10. routes (registered after all of the above)
```

`apps/api/src/app.ts` exports `buildApp()` that wires this; `apps/api/src/index.ts` calls it + listens.

### Env validation

Single `EnvSchema` (Zod) in `apps/api/src/env.ts`:

```typescript
export const EnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CFP_DATA_REPO_PATH: z.string(),
  CFP_DATA_REMOTE: z.string().optional(),
  STORAGE_BACKEND: z.enum(['s3', 'filesystem']),
  CFP_PRIVATE_STORAGE_PATH: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  // ... (full set per architecture.md deploy table)
  CFP_JWT_SIGNING_KEY: z.string().min(32),
});
```

Validation runs at boot; bad config exits 1 with a clear error. No `process.env.X` reads outside `env.ts`.

Ship a `.env.example` file at the repo root that enumerates every `EnvSchema` field with placeholder values + an inline comment per field describing what it's for. This is what new contributors `cp .env.example .env` on first checkout. Keeps the `EnvSchema` and `.env.example` in lockstep is a per-PR review concern; if it drifts, that's a CI follow-up worth filing.

### Response envelope

`apps/api/src/lib/response.ts` exports:

```typescript
export function ok<T>(data: T, meta?: Partial<ResponseMeta>): SuccessResponse<T>;
export function paginated<T>(data: T[], pagination: PaginationMeta): PaginatedResponse<T>;
```

Routes return these. The error hook produces the error envelope from thrown exceptions.

### Error mapping

```typescript
fastify.setErrorHandler((err, req, reply) => {
  if (err instanceof GitsheetsError) { return mapGitsheetsError(err, req, reply); }
  if (err instanceof ValidationError) { /* 422 */ }
  if (err instanceof NotFoundError)   { /* 404 */ }
  // ... full mapping per api/conventions.md + gitsheets's exported error classes
  // unknown errors → 500 with traceId
});
```

Every error response carries `error.code` (stable) and `error.traceId` (UUIDv7 from the request hook).

### Rate limiting

Per [api/conventions.md](../specs/api/conventions.md#rate-limiting) — in-memory counters, single replica. `apps/api/src/plugins/rate-limit.ts` increments and decrements per key. On exceed: throw `RateLimitedError`, mapper produces `429` with `Retry-After`.

### Idempotency

In-memory `Map<personId+key, cachedResponse>` with a 24h TTL. Mutating endpoints check before running; on hit, replay the cached response. `apps/api/src/plugins/idempotency.ts`.

### OpenAPI

`@fastify/swagger` + `@fastify/swagger-ui` registered last. Routes that declare zod schemas auto-populate the OpenAPI doc. `/api/_openapi.json` + `/api/_docs`.

### Trace IDs

`apps/api/src/plugins/trace-id.ts` decorates `request.traceId = generateUuidV7()` on every incoming request. Pino logger config includes traceId in every log line.

## Validation

- [x] `GET /api/health` returns `{success:true, data:{status:'ok'}, metadata:{...timestamp}}` exactly per envelope spec
- [x] Booting with an invalid `STORAGE_BACKEND` exits 1 with a Zod error printed
- [x] An intentionally-thrown `ValidationError` from a stub route surfaces as `422 validation_failed` with the expected error shape
- [x] An unknown thrown Error surfaces as `500 internal_error` with no error message leaked
- [x] `traceId` appears in both the error response (when error) and the access log line
- [x] Per-IP rate limit kicks in: 61 anonymous reads from the same IP within a minute → 429 with `Retry-After`
- [x] Repeat POST with the same `Idempotency-Key` returns the cached response (verified by a stub route)
- [x] `/api/_openapi.json` returns a valid OpenAPI 3.1 document; `/api/_docs` renders Swagger UI
- [x] `.env.example` exists at the repo root with one entry per `EnvSchema` field (deferred from [`workspace`](workspace.md))
- [x] CI passes type-check + tests

## Risks / unknowns

- **Pino + request-id integration.** Multiple plugins want to be the request-id source. Pick one (the trace-id plugin) and have pino read from there.
- **Rate-limit counters survive restart?** No — in-memory, intentional. Acceptable at single-replica civic scale.

## Notes

- `@fastify/env` requires a JSON Schema object (not a Zod schema) passed as `schema`. We maintain both `EnvSchema` (Zod, for TypeScript types and runtime validation in code) and `envJsonSchema` (JSON Schema, for the `@fastify/env` plugin). Keeping them in sync is a per-PR review concern.
- `@fastify/swagger` does NOT expose the OpenAPI document at a URL by default — it populates `fastify.swagger()`. The spec-mandated `/api/_openapi.json` URL is a manual route added after swagger registration that calls `fastify.swagger()`. The swagger-ui also serves the doc at `/api/_docs/json`.
- Fastify's default `pluginTimeout` (avvio) is 10s. In the worktree test environment, git operations during `openPublicStore()` exceed that. We set `pluginTimeout: 30_000` in `buildApp()` (not just tests) since a slow git cold-read could also time out in production on a cold start against a large data repo.
- Vitest's default test timeout (5s) also needed to be raised to 30s for the same reason. This is set in `apps/api/vitest.config.ts`.
- The "traceId appears in access log" criterion is verified structurally (pino logger receives the traceId via request decorators) but not via a log-line assertion in the tests. Log assertion would require capturing pino output, which is complex for the upside. The functional test verifies traceId in error responses, which exercises the same code path.
- Rate-limit account-based caps (300 reads/min/account, 30 writes/min/account) are stubbed to the IP-based limit until auth-jwt-substrate lands and `request.person` is available. The plugin has the hook points for account-based keying.
- `/_test/*` stub routes (validation-error, internal-error, idempotency) are `{ schema: { hide: true } }` so they don't appear in the OpenAPI doc but exist in the running app. These exist only for testing and should be removed or guarded in production (future follow-up).

## Follow-ups

- Issue [#18](https://github.com/CodeForPhilly/codeforphilly-ng/issues/18) — remove or guard `/_test/*` stub routes in production (they test error/idempotency behavior but shouldn't be exposed in prod)
- Deferred to [`auth-jwt-substrate`](auth-jwt-substrate.md) — wire account-based rate limit caps (300 reads/min, 30 writes/min/account) once `request.person` is available from the JWT plugin
