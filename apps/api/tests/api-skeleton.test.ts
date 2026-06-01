/**
 * Tests for the api-skeleton plan validation criteria.
 *
 * Covers:
 *  - GET /api/health returns envelope-wrapped { status: 'ok' }
 *  - ValidationError surfaces as 422 validation_failed with expected shape
 *  - Unknown Error surfaces as 500 internal_error with no message leak
 *  - traceId appears in error responses
 *  - Per-IP rate limit: 61 anonymous reads → 429 with Retry-After
 *  - Idempotency-Key: repeat POST returns cached response
 *  - /api/_openapi.json returns a valid OpenAPI 3.1 document
 *  - /api/_docs renders (200 response)
 *  - Booting with invalid config throws
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;

async function buildTestApp(
  overrides: Partial<Record<string, string>> = {},
  dataPath = dataRepo.path,
  privatePath = privateStore.path,
): Promise<FastifyInstance> {
  return buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataPath,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privatePath,
      CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
      NODE_ENV: 'test',
      ...overrides,
    },
  });
}

beforeEach(async () => {
  dataRepo = await createFullDataRepo();
  privateStore = await createPrivateStorageDir();
  app = await buildTestApp();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  await dataRepo.cleanup();
  await privateStore.cleanup();
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('returns 200 with the success envelope', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ success: boolean; data: { status: string }; metadata: { timestamp: string } }>();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(typeof body.metadata.timestamp).toBe('string');
    // Timestamp should be ISO 8601
    expect(new Date(body.metadata.timestamp).toISOString()).toBe(body.metadata.timestamp);
  });
});

// ---------------------------------------------------------------------------
// Error mapper
// ---------------------------------------------------------------------------

describe('error mapper', () => {
  it('ValidationError → 422 validation_failed with field details and traceId', async () => {
    const res = await app!.inject({ method: 'POST', url: '/api/_test/validation-error' });
    expect(res.statusCode).toBe(422);

    const body = res.json<{
      success: boolean;
      error: { code: string; message: string; traceId: string; fields?: Record<string, string> };
      metadata: { timestamp: string };
    }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('validation_failed');
    expect(typeof body.error.message).toBe('string');
    // traceId must be present
    expect(typeof body.error.traceId).toBe('string');
    expect(body.error.traceId!.length).toBeGreaterThan(0);
  });

  it('unknown Error → 500 internal_error with no message leaked', async () => {
    const res = await app!.inject({ method: 'POST', url: '/api/_test/internal-error' });
    expect(res.statusCode).toBe(500);

    const body = res.json<{
      success: boolean;
      error: { code: string; message: string; traceId: string };
      metadata: { timestamp: string };
    }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('internal_error');
    // Must not leak the actual error message
    expect(body.error.message).not.toContain('Deliberate');
    expect(body.error.message).not.toContain('should not leak');
    // traceId must be present
    expect(typeof body.error.traceId).toBe('string');
    expect(body.error.traceId!.length).toBeGreaterThan(0);
  });

  it('traceId in error response matches UUIDv7 format', async () => {
    const res = await app!.inject({ method: 'POST', url: '/api/_test/internal-error' });
    const body = res.json<{ error: { traceId: string } }>();
    const traceId = body.error.traceId;
    // UUIDv7 format: 8-4-4-4-12 hex, version nibble = 7
    expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

// ---------------------------------------------------------------------------
// /api/_test/* gating (issue #116)
//
// The test-harness routes exist only to exercise the error-mapping +
// idempotency code paths from CI. In NODE_ENV=production they must NOT
// be registered — no reason a prod caller should be able to hit
// /api/_test/internal-error and force a 500.
// ---------------------------------------------------------------------------

describe('/api/_test/* route gating', () => {
  it('returns 404 for all three test-harness routes when NODE_ENV=production', async () => {
    // Close the default (NODE_ENV=test) app so the prod-mode app gets
    // a clean fixture. The base afterEach takes care of the rest.
    if (app) {
      await app.close();
      app = undefined;
    }
    const prodApp = await buildTestApp({ NODE_ENV: 'production' });
    try {
      const paths = [
        '/api/_test/validation-error',
        '/api/_test/internal-error',
        '/api/_test/idempotency',
      ];
      for (const url of paths) {
        const res = await prodApp.inject({ method: 'POST', url });
        expect(res.statusCode, `expected ${url} to 404 in production`).toBe(404);
      }
      // Sanity: real routes still respond.
      const health = await prodApp.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      await prodApp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('61 anonymous reads from the same IP → 429 with Retry-After on the 61st', async () => {
    // Make 60 reads — all should succeed
    for (let i = 0; i < 60; i++) {
      const res = await app!.inject({
        method: 'GET',
        url: '/api/health',
        remoteAddress: '10.0.0.1',
      });
      expect(res.statusCode, `Request ${i + 1} should succeed`).toBe(200);
    }

    // The 61st should be rate-limited
    const res = await app!.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '10.0.0.1',
    });
    expect(res.statusCode).toBe(429);

    const body = res.json<{ success: boolean; error: { code: string } }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('rate_limited');

    // Retry-After header must be present
    const retryAfter = res.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('repeat POST with same Idempotency-Key returns the cached response', async () => {
    const key = 'test-idempotency-key-abc123';

    const first = await app!.inject({
      method: 'POST',
      url: '/api/_test/idempotency',
      headers: { 'idempotency-key': key },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ data: { echoed: string; at: string } }>();

    // Second request with the same key — should return identical body
    const second = await app!.inject({
      method: 'POST',
      url: '/api/_test/idempotency',
      headers: { 'idempotency-key': key },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ data: { echoed: string; at: string } }>();

    // The `at` timestamp must be frozen — both responses are the same cached copy
    expect(secondBody.data.echoed).toBe(firstBody.data.echoed);
    expect(secondBody.data.at).toBe(firstBody.data.at);

    // Different key → fresh response (different `at` possible but same shape)
    const third = await app!.inject({
      method: 'POST',
      url: '/api/_test/idempotency',
      headers: { 'idempotency-key': 'a-different-key' },
    });
    expect(third.statusCode).toBe(200);
    const thirdBody = third.json<{ data: { at: string } }>();

    // The `at` may be same or later, but must be a valid timestamp
    expect(new Date(thirdBody.data.at).getTime()).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAPI / Swagger UI
// ---------------------------------------------------------------------------

describe('OpenAPI', () => {
  it('/api/_openapi.json returns a valid OpenAPI 3.1 document', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/_openapi.json' });
    expect(res.statusCode).toBe(200);

    const doc = res.json<{
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
    }>();

    expect(doc.openapi).toMatch(/^3\.1/);
    expect(typeof doc.info.title).toBe('string');
    expect(typeof doc.paths).toBe('object');
  });

  it('/api/_docs renders Swagger UI (200 or 3xx)', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/_docs' });
    // Swagger UI may redirect to /api/_docs/ — check not 4xx/5xx
    expect(res.statusCode).toBeLessThan(400);
  });
});

// ---------------------------------------------------------------------------
// Env validation (integration — separate app instance)
// ---------------------------------------------------------------------------

describe('env validation', () => {
  it('throws on missing CFP_DATA_REPO_PATH', async () => {
    await expect(
      buildApp({
        serverOptions: { logger: false },
        overrideEnv: {
          // CFP_DATA_REPO_PATH intentionally omitted
          STORAGE_BACKEND: 'filesystem',
          CFP_PRIVATE_STORAGE_PATH: '/tmp/test',
          CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
          NODE_ENV: 'test',
        },
      }),
    ).rejects.toThrow();
  });

  it('throws on invalid STORAGE_BACKEND value', async () => {
    await expect(
      buildApp({
        serverOptions: { logger: false },
        overrideEnv: {
          CFP_DATA_REPO_PATH: '/tmp/nonexistent',
          STORAGE_BACKEND: 'invalid-backend',
          CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
          NODE_ENV: 'test',
        },
      }),
    ).rejects.toThrow();
  });
});
