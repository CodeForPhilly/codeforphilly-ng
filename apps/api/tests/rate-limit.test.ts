/**
 * Rate limiter scope — specs/api/conventions.md#rate-limiting.
 *
 * Covers what broke at cutover:
 *  - non-/api requests (SPA shell, assets, thumbnails) are never counted
 *  - GET /api/auth/me is an ordinary read, not a credential call
 *  - credential endpoints share one per-IP bucket at RATE_LIMITS.credentialPerIp
 *  - the unauthenticated read cap still trips one past RATE_LIMITS.unauthenticatedReadsPerIp
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { RATE_LIMITS, isCredentialPath } from '../src/plugins/rate-limit.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;

const IP = '203.0.113.7';

beforeEach(async () => {
  dataRepo = await createFullDataRepo();
  privateStore = await createPrivateStorageDir();
  app = await buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataRepo.path,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
      NODE_ENV: 'test',
    },
  });
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  await dataRepo.cleanup();
  await privateStore.cleanup();
});

function bucket(key: string): number {
  return app!.rateLimitBuckets.ip.get(key)?.count ?? 0;
}

describe('rate limiter scope', () => {
  it('does not count non-/api requests (SPA shell, assets, thumbnails)', async () => {
    for (const url of ['/', '/login', '/assets/index-abc123.js', '/thumbnail/1/100x100']) {
      const res = await app!.inject({ method: 'GET', url, headers: { 'x-forwarded-for': IP } });
      expect(res.statusCode).not.toBe(429);
    }
    expect(app!.rateLimitBuckets.ip.size).toBe(0);
  });

  it('treats GET /api/auth/me as a read, not a credential call', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-forwarded-for': IP },
    });
    expect(res.statusCode).toBe(200);
    expect(bucket(`read:${IP}`)).toBe(1);
    expect(bucket(`credential:${IP}`)).toBe(0);
  });

  it('classifies credential endpoints', () => {
    for (const p of [
      '/api/auth/login',
      '/api/auth/github/start',
      '/api/auth/github/callback',
      '/api/auth/link-github',
      '/api/auth/password-reset/request',
      '/api/auth/password-reset/confirm',
      '/api/account-claim/by-password',
    ]) {
      expect(isCredentialPath(p), p).toBe(true);
    }
    for (const p of ['/api/auth/me', '/api/auth/refresh', '/api/auth/sessions', '/api/auth/logout', '/api/people']) {
      expect(isCredentialPath(p), p).toBe(false);
    }
  });

  it('caps credential endpoints per IP at RATE_LIMITS.credentialPerIp', async () => {
    const limit = RATE_LIMITS.credentialPerIp;
    let last = 0;
    for (let i = 0; i < limit + 1; i++) {
      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': IP, 'content-type': 'application/json' },
        payload: {},
      });
      last = res.statusCode;
      if (i < limit) expect(res.statusCode).not.toBe(429);
    }
    expect(last).toBe(429);
    expect(bucket(`read:${IP}`)).toBe(0);
  });

  it('caps unauthenticated reads per IP one past RATE_LIMITS.unauthenticatedReadsPerIp', async () => {
    const limit = RATE_LIMITS.unauthenticatedReadsPerIp;
    // Prime the bucket directly rather than issuing 1200 requests.
    app!.rateLimitBuckets.ip.set(`read:${IP}`, { count: limit - 1, windowStart: Date.now() });
    const ok = await app!.inject({ method: 'GET', url: '/api/health', headers: { 'x-forwarded-for': IP } });
    expect(ok.statusCode).toBe(200);
    const over = await app!.inject({ method: 'GET', url: '/api/health', headers: { 'x-forwarded-for': IP } });
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
  });
});
