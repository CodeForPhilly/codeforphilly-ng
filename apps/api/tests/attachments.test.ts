/**
 * Tests for GET /api/attachments/:key — implements
 * specs/behaviors/storage.md → "Attachments".
 *
 * Seeds binary blobs at the path the attachment key points to, then
 * exercises the route via Fastify inject. Path-traversal + missing-key
 * cases verify the validator and the git-cat-file failure translation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawBlob } from './helpers/seed-fixtures.js';

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;

async function bootApp(): Promise<FastifyInstance> {
  return buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataRepo.path,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
      NODE_ENV: 'test',
    },
  });
}

// Minimal valid PNG: 8-byte signature + IHDR + IEND. Not a real image
// (no IDAT), but byte-comparable through git cat-file and the route.
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk header
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x00, 0x00, 0x00, 0x00, 0x3b, 0x7e, 0x9b,
  0x55, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

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
});

describe('GET /api/attachments/*', () => {
  it('serves a seeded avatar by key with image/png Content-Type', async () => {
    await seedRawBlob(
      dataRepo.path,
      'people/chris/avatar.png',
      TINY_PNG,
      'seed avatar for chris',
    );
    app = await bootApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/people/chris/avatar.png',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('max-age=3600');
    expect(Buffer.from(res.rawPayload).equals(TINY_PNG)).toBe(true);
  });

  it('infers Content-Type from each known extension', async () => {
    const cases: Array<{ path: string; type: string }> = [
      { path: 'people/a/avatar.jpg', type: 'image/jpeg' },
      { path: 'people/b/avatar.jpeg', type: 'image/jpeg' },
      { path: 'people/c/avatar.webp', type: 'image/webp' },
      { path: 'people/d/avatar.gif', type: 'image/gif' },
      { path: 'people/e/avatar.svg', type: 'image/svg+xml' },
      { path: 'people/f/doc.pdf', type: 'application/pdf' },
      { path: 'people/g/unknown.xyz', type: 'application/octet-stream' },
    ];
    for (const { path } of cases) {
      await seedRawBlob(dataRepo.path, path, Buffer.from([0x00, 0x01]), `seed ${path}`);
    }
    app = await bootApp();

    for (const { path, type } of cases) {
      const res = await app.inject({ method: 'GET', url: `/api/attachments/${path}` });
      expect(res.statusCode, `${path} status`).toBe(200);
      expect(res.headers['content-type'], `${path} content-type`).toBe(type);
    }
  });

  it('returns 404 for a key not in HEAD', async () => {
    app = await bootApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/people/nobody/avatar.png',
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('not_found');
  });

  it('does not serve files outside the data repo via URL-based traversal', async () => {
    // Fastify normalizes `..` segments in the URL path before our handler
    // sees them, so `/api/attachments/../etc/passwd` becomes `/etc/passwd`
    // (no route match → 404). Our validator catches `..` segments too as
    // defense in depth, but the operative contract is: traversal never
    // serves a 200 from a file outside the data repo.
    app = await bootApp();
    const cases = [
      '/api/attachments/../etc/passwd',
      '/api/attachments/people/../../foo',
    ];
    for (const url of cases) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).not.toBe(200);
    }
  });

  it('rejects keys with embedded null bytes with 422', async () => {
    app = await bootApp();
    // %00 decodes to a null byte; the validator rejects control chars
    // explicitly so even if Fastify lets it through to the route, we 422.
    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/people/chris/avatar%00.png',
    });
    expect(res.statusCode).toBe(422);
  });

  it('serves binary content byte-identical (no transcoding)', async () => {
    // Include all bytes 0-255 to verify the streaming path is byte-clean.
    const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await seedRawBlob(
      dataRepo.path,
      'people/binary-test/data.bin',
      allBytes,
      'seed binary test',
    );
    app = await bootApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/people/binary-test/data.bin',
    });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(allBytes)).toBe(true);
  });
});
