/**
 * Tests for POST /api/people/:slug/avatar — multipart upload + sharp
 * processing + gitsheets setAttachment + Person.avatarKey update + the
 * round-trip through the attachments-serving route from #94.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import FormData from 'form-data';
import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';
import { mintSessionFor } from '../src/auth/issue.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';

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
      CFP_JWT_SIGNING_KEY: JWT_KEY,
      NODE_ENV: 'test',
    },
  });
}

async function seedPerson(
  slug: string,
  id: string,
  accountLevel: 'user' | 'staff' | 'administrator' = 'user',
): Promise<void> {
  await seedRawToml(
    dataRepo.path,
    `people/${slug}.toml`,
    [
      `id = "${id}"`,
      `slug = "${slug}"`,
      `fullName = "Test ${slug}"`,
      `accountLevel = "${accountLevel}"`,
      `createdAt = "2026-05-01T00:00:00Z"`,
      `updatedAt = "2026-05-01T00:00:00Z"`,
    ].join('\n'),
    `seed person ${slug}`,
  );
}

/** Generate a non-square test image so the center-crop is observable. */
async function makeTestImage(opts: {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'webp';
  background?: { r: number; g: number; b: number; alpha: number };
}): Promise<Buffer> {
  const { width, height, format, background = { r: 255, g: 0, b: 0, alpha: 1 } } = opts;
  const base = sharp({
    create: { width, height, channels: 4, background },
  });
  if (format === 'png') return base.png().toBuffer();
  if (format === 'jpeg') return base.jpeg().toBuffer();
  return base.webp().toBuffer();
}

async function injectMultipart(
  instance: FastifyInstance,
  opts: {
    url: string;
    field: string;
    filename: string;
    contentType: string;
    body: Buffer;
    cookieToken?: string;
  },
): Promise<ReturnType<FastifyInstance['inject']>> {
  const form = new FormData();
  form.append(opts.field, opts.body, {
    filename: opts.filename,
    contentType: opts.contentType,
  });
  const payload = form.getBuffer();
  const headers: Record<string, string> = {
    ...form.getHeaders(),
    'content-length': String(payload.length),
  };
  if (opts.cookieToken) headers['cookie'] = `cfp_session=${opts.cookieToken}`;
  return instance.inject({
    method: 'POST',
    url: opts.url,
    headers,
    payload,
  });
}

const PERSON_ID = '01951a3c-0000-7000-8000-000000000001';
const ADMIN_ID = '01951a3c-0000-7000-8000-000000000002';
const OTHER_ID = '01951a3c-0000-7000-8000-000000000003';

beforeEach(async () => {
  dataRepo = await createFullDataRepo();
  privateStore = await createPrivateStorageDir();
  await seedPerson('me', PERSON_ID, 'user');
  await seedPerson('boss', ADMIN_ID, 'administrator');
  await seedPerson('other', OTHER_ID, 'user');
  app = await bootApp();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  await dataRepo.cleanup();
  await privateStore.cleanup();
});

describe('POST /api/people/:slug/avatar', () => {
  it('accepts a PNG upload from the person themselves and returns the avatar URL', async () => {
    const png = await makeTestImage({ width: 200, height: 100, format: 'png' });
    const { accessToken } = await mintSessionFor(PERSON_ID, 'user', JWT_KEY);

    const res = await injectMultipart(app!, {
      url: '/api/people/me/avatar',
      field: 'image',
      filename: 'avatar.png',
      contentType: 'image/png',
      body: png,
      cookieToken: accessToken,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.avatarUrl).toBe('/api/attachments/people/me/avatar.jpg');
  });

  it('round-trips: uploaded bytes fetchable via /api/attachments/<key>', async () => {
    const jpeg = await makeTestImage({ width: 300, height: 300, format: 'jpeg' });
    const { accessToken } = await mintSessionFor(PERSON_ID, 'user', JWT_KEY);

    const uploadRes = await injectMultipart(app!, {
      url: '/api/people/me/avatar',
      field: 'image',
      filename: 'avatar.jpg',
      contentType: 'image/jpeg',
      body: jpeg,
      cookieToken: accessToken,
    });
    expect(uploadRes.statusCode).toBe(200);

    // Now read it back via the attachments-serving route from #94.
    const fetchRes = await app!.inject({
      method: 'GET',
      url: '/api/attachments/people/me/avatar.jpg',
    });
    expect(fetchRes.statusCode).toBe(200);
    expect(fetchRes.headers['content-type']).toBe('image/jpeg');

    // Decode the served bytes — should be a valid JPEG, exactly 300×300 (square).
    const meta = await sharp(Buffer.from(fetchRes.rawPayload)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(300);

    // And the thumbnail is exactly 128×128.
    const thumbRes = await app!.inject({
      method: 'GET',
      url: '/api/attachments/people/me/avatar-128.jpg',
    });
    expect(thumbRes.statusCode).toBe(200);
    const thumbMeta = await sharp(Buffer.from(thumbRes.rawPayload)).metadata();
    expect(thumbMeta.width).toBe(128);
    expect(thumbMeta.height).toBe(128);
  });

  it('center-crops a non-square image to a square original', async () => {
    const wide = await makeTestImage({ width: 400, height: 200, format: 'png' });
    const { accessToken } = await mintSessionFor(PERSON_ID, 'user', JWT_KEY);

    const res = await injectMultipart(app!, {
      url: '/api/people/me/avatar',
      field: 'image',
      filename: 'avatar.png',
      contentType: 'image/png',
      body: wide,
      cookieToken: accessToken,
    });
    expect(res.statusCode).toBe(200);

    const fetchRes = await app!.inject({
      method: 'GET',
      url: '/api/attachments/people/me/avatar.jpg',
    });
    const meta = await sharp(Buffer.from(fetchRes.rawPayload)).metadata();
    // Shorter edge is 200; original output should be 200×200.
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(200);
  });

  it('accepts WebP uploads', async () => {
    const webp = await makeTestImage({ width: 250, height: 250, format: 'webp' });
    const { accessToken } = await mintSessionFor(PERSON_ID, 'user', JWT_KEY);

    const res = await injectMultipart(app!, {
      url: '/api/people/me/avatar',
      field: 'image',
      filename: 'avatar.webp',
      contentType: 'image/webp',
      body: webp,
      cookieToken: accessToken,
    });
    expect(res.statusCode).toBe(200);
  });

  it('admin can upload an avatar on behalf of another person', async () => {
    const png = await makeTestImage({ width: 200, height: 200, format: 'png' });
    const { accessToken } = await mintSessionFor(ADMIN_ID, 'administrator', JWT_KEY);

    const res = await injectMultipart(app!, {
      url: '/api/people/me/avatar',
      field: 'image',
      filename: 'avatar.png',
      contentType: 'image/png',
      body: png,
      cookieToken: accessToken,
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an upload from a different non-admin user with 403', async () => {
    const png = await makeTestImage({ width: 200, height: 200, format: 'png' });
    const { accessToken } = await mintSessionFor(OTHER_ID, 'user', JWT_KEY);

    const res = await injectMultipart(app!, {
      url: '/api/people/me/avatar',
      field: 'image',
      filename: 'avatar.png',
      contentType: 'image/png',
      body: png,
      cookieToken: accessToken,
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unauthenticated upload with 403', async () => {
    const png = await makeTestImage({ width: 200, height: 200, format: 'png' });
    const res = await injectMultipart(app!, {
      url: '/api/people/me/avatar',
      field: 'image',
      filename: 'avatar.png',
      contentType: 'image/png',
      body: png,
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s for a missing person', async () => {
    const png = await makeTestImage({ width: 200, height: 200, format: 'png' });
    const { accessToken } = await mintSessionFor(PERSON_ID, 'user', JWT_KEY);

    const res = await injectMultipart(app!, {
      url: '/api/people/nonexistent/avatar',
      field: 'image',
      filename: 'avatar.png',
      contentType: 'image/png',
      body: png,
      cookieToken: accessToken,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects unsupported MIME types with 422', async () => {
    const fakeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const { accessToken } = await mintSessionFor(PERSON_ID, 'user', JWT_KEY);

    const res = await injectMultipart(app!, {
      url: '/api/people/me/avatar',
      field: 'image',
      filename: 'avatar.svg',
      contentType: 'image/svg+xml',
      body: fakeSvg,
      cookieToken: accessToken,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('rejects wrong field name with 422', async () => {
    const png = await makeTestImage({ width: 200, height: 200, format: 'png' });
    const { accessToken } = await mintSessionFor(PERSON_ID, 'user', JWT_KEY);

    const res = await injectMultipart(app!, {
      url: '/api/people/me/avatar',
      field: 'photo',
      filename: 'avatar.png',
      contentType: 'image/png',
      body: png,
      cookieToken: accessToken,
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects uploads larger than 5 MB', async () => {
    // @fastify/multipart's `fileSize` limit triggers at the wire layer,
    // before our route's sharp pipeline ever runs. So an oversized payload
    // doesn't have to be a valid image — random bytes labeled image/jpeg
    // exercise the size cap directly.
    const big = Buffer.alloc(6 * 1024 * 1024, 0);
    // Seed with a JPEG SOI marker just in case anything along the pipeline
    // sniffs the first byte before raising the size error.
    big[0] = 0xff;
    big[1] = 0xd8;

    const { accessToken } = await mintSessionFor(PERSON_ID, 'user', JWT_KEY);
    const res = await injectMultipart(app!, {
      url: '/api/people/me/avatar',
      field: 'image',
      filename: 'big.jpg',
      contentType: 'image/jpeg',
      body: big,
      cookieToken: accessToken,
    });
    // @fastify/multipart's fileSize limit surfaces as a 4xx — we translate
    // it to 422 (validation_failed with image: too_large) for envelope
    // consistency with the spec's other size-rejection cases.
    expect([413, 422]).toContain(res.statusCode);
  });
});
