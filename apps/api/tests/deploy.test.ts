/**
 * Tests for the deploy plan validation criteria.
 *
 * Covers:
 *  - GET /api/health/ready returns 200 with the store-readiness flags set
 *  - Static-web plugin disabled by default (no CFP_WEB_DIST_PATH): /api/* still
 *    returns the JSON 404 envelope and arbitrary paths 404 as JSON, not HTML
 *  - Static-web plugin with CFP_WEB_DIST_PATH set: arbitrary path falls
 *    through to index.html (SPA fallback); /api/* paths still 404 as JSON
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let webDist: string | undefined;
let app: FastifyInstance | undefined;

async function buildTestApp(
  overrides: Partial<Record<string, string>> = {},
): Promise<FastifyInstance> {
  return buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataRepo.path,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
      NODE_ENV: 'test',
      ...overrides,
    },
  });
}

beforeEach(async () => {
  dataRepo = await createFullDataRepo();
  privateStore = await createPrivateStorageDir();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  await dataRepo.cleanup();
  await privateStore.cleanup();
  if (webDist) {
    await rm(webDist, { recursive: true, force: true });
    webDist = undefined;
  }
});

describe('GET /api/health/ready', () => {
  it('returns 200 with store-readiness flags after boot', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      data: { status: string; publicStore: boolean; privateStore: boolean; fts: boolean };
    }>();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ready');
    expect(body.data.publicStore).toBe(true);
    expect(body.data.privateStore).toBe(true);
    expect(body.data.fts).toBe(true);
  });
});

describe('static-web plugin', () => {
  it('is disabled when CFP_WEB_DIST_PATH is unset; /api/* 404s as JSON envelope', async () => {
    app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ success: boolean; error: { code: string } }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('not_found');
  });

  it('serves index.html for non-/api/* paths when CFP_WEB_DIST_PATH points at a valid dist', async () => {
    webDist = await mkdtemp(join(tmpdir(), 'cfp-web-dist-'));
    await mkdir(join(webDist, 'assets'), { recursive: true });
    await writeFile(join(webDist, 'index.html'), '<!doctype html><title>cfp</title>');
    await writeFile(join(webDist, 'assets', 'app-deadbeef.js'), 'console.log("hi")');

    app = await buildTestApp({ CFP_WEB_DIST_PATH: webDist });

    // SPA fallback: arbitrary path serves index.html
    const spaRes = await app.inject({ method: 'GET', url: '/projects/some-slug' });
    expect(spaRes.statusCode).toBe(200);
    expect(spaRes.headers['content-type']).toMatch(/text\/html/);
    expect(spaRes.body).toContain('<title>cfp</title>');
    expect(spaRes.headers['cache-control']).toContain('no-cache');

    // Hashed asset served directly with long cache
    const assetRes = await app.inject({ method: 'GET', url: '/assets/app-deadbeef.js' });
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.body).toContain('console.log');

    // /api/* unknown route still returns JSON 404, not HTML
    const apiRes = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(apiRes.statusCode).toBe(404);
    expect(apiRes.headers['content-type']).toMatch(/application\/json/);
    const apiBody = apiRes.json<{ success: boolean; error: { code: string } }>();
    expect(apiBody.success).toBe(false);
    expect(apiBody.error.code).toBe('not_found');
  });

  it('throws on boot when CFP_WEB_DIST_PATH points at a non-existent directory', async () => {
    await expect(
      buildTestApp({ CFP_WEB_DIST_PATH: '/nonexistent/cfp-web-dist-please-do-not-exist' }),
    ).rejects.toThrow(/CFP_WEB_DIST_PATH/);
  });
});
