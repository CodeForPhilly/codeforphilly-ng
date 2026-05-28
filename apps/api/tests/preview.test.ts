/**
 * Tests for POST /api/_preview — the markdown editor's server-side preview
 * endpoint, per specs/behaviors/markdown-rendering.md.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;

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

describe('POST /api/_preview', () => {
  it('renders markdown source to sanitized HTML', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/_preview',
      payload: { source: '# Hello\n\n**bold** and `code`.' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // h1 demotes to h3 per the pipeline; bold/code preserved
    expect(body.data.html).toContain('<h3>Hello</h3>');
    expect(body.data.html).toContain('<strong>bold</strong>');
    expect(body.data.html).toContain('<code>code</code>');
  });

  it('strips dangerous HTML (script / on-attributes)', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/_preview',
      payload: {
        source: '<script>alert(1)</script>\n\n<a href="javascript:void(0)" onclick="x()">x</a>',
      },
    });
    expect(res.statusCode).toBe(200);
    const html = res.json().data.html as string;
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onclick');
  });

  it('rejects missing source with 422', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/_preview',
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects oversized source with 422', async () => {
    const giant = 'a '.repeat(30_000); // ~60k chars, exceeds 50k cap
    const res = await app!.inject({
      method: 'POST',
      url: '/api/_preview',
      payload: { source: giant },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rewrites foreign-host anchors with target=_blank rel=noopener nofollow', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/_preview',
      payload: { source: '[news](https://example.com/story) and [home](/projects)' },
    });
    const html = res.json().data.html as string;
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="noopener nofollow"|rel="nofollow noopener"/);
    // Internal link untouched
    expect(html).toContain('href="/projects">home</a>');
    // Anchor count: 2; only one carries target
    expect((html.match(/target="_blank"/g) ?? []).length).toBe(1);
  });
});

describe('POST /api/_preview — @mention resolution', () => {
  beforeEach(async () => {
    // The test rig seeded above clears between cases; reseed a Person so the
    // resolver has something to find. Skip if buildApp pulled state already —
    // the helper writes a TOML, then we need a fresh app to see it.
    await seedRawToml(
      dataRepo.path,
      'people/chris.toml',
      [
        'id = "019e4021-0000-7000-8000-000000000001"',
        'slug = "chris"',
        'fullName = "Test chris"',
        'accountLevel = "user"',
        'createdAt = "2026-05-01T00:00:00Z"',
        'updatedAt = "2026-05-01T00:00:00Z"',
      ].join('\n'),
      'seed person chris',
    );
    // Re-boot the app so it loads the new state.
    await app!.close();
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

  it('linkifies @<slug> when the slug resolves to a Person', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/_preview',
      payload: { source: 'hi @chris, welcome' },
    });
    const html = res.json().data.html as string;
    expect(html).toContain('<a href="/members/chris">@chris</a>');
  });

  it('leaves unknown @mentions as literal text', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/_preview',
      payload: { source: 'cc @nobody for context' },
    });
    const html = res.json().data.html as string;
    expect(html).not.toContain('href="/members/nobody"');
    expect(html).toContain('@nobody');
  });
});
