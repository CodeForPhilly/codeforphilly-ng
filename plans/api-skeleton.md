---
status: in-progress
depends: [storage-foundation]
specs:
  - specs/api/conventions.md
upstream-specs:
  # gitsheets defines its own error class hierarchy; the API maps those to the response envelope
  - gitsheets:specs/api/errors.md
issues: []
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

- [ ] `GET /api/health` returns `{success:true, data:{status:'ok'}, metadata:{...timestamp}}` exactly per envelope spec
- [ ] Booting with an invalid `STORAGE_BACKEND` exits 1 with a Zod error printed
- [ ] An intentionally-thrown `ValidationError` from a stub route surfaces as `422 validation_failed` with the expected error shape
- [ ] An unknown thrown Error surfaces as `500 internal_error` with no error message leaked
- [ ] `traceId` appears in both the error response (when error) and the access log line
- [ ] Per-IP rate limit kicks in: 61 anonymous reads from the same IP within a minute → 429 with `Retry-After`
- [ ] Repeat POST with the same `Idempotency-Key` returns the cached response (verified by a stub route)
- [ ] `/api/_openapi.json` returns a valid OpenAPI 3.1 document; `/api/_docs` renders Swagger UI
- [ ] `.env.example` exists at the repo root with one entry per `EnvSchema` field (deferred from [`workspace`](workspace.md))
- [ ] CI passes type-check + tests

## Risks / unknowns

- **Pino + request-id integration.** Multiple plugins want to be the request-id source. Pick one (the trace-id plugin) and have pino read from there.
- **Rate-limit counters survive restart?** No — in-memory, intentional. Acceptable at single-replica civic scale.

## Notes
