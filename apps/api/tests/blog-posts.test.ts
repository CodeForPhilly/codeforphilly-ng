/**
 * Tests for GET /api/blog-posts list + detail per specs/api/blog.md.
 *
 * The blog-posts sheet is content-typed (`[gitsheet.format] type='markdown'
 * body='body'`), so on-disk artifacts are Hugo-style markdown files with
 * `+++` TOML frontmatter. Tests seed records via `seedRawBlob` writing the
 * full `+++\n<frontmatter>\n+++\n\n<body>\n` shape gitsheets expects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawBlob } from './helpers/seed-fixtures.js';

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;

const UUID_A = '01951a3c-0000-7000-8000-aaaaaaaaaaaa';
const UUID_B = '01951a3c-0000-7000-8000-bbbbbbbbbbbb';
const UUID_C = '01951a3c-0000-7000-8000-cccccccccccc';

/** Build a markdown record's on-disk bytes per gitsheets' markdown format. */
function blogRecord(frontmatter: Record<string, unknown>, body: string): Buffer {
  const lines = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k} = ${JSON.stringify(v)}`;
      return `${k} = ${JSON.stringify(v)}`;
    })
    .join('\n');
  return Buffer.from(`+++\n${lines}\n+++\n\n${body}\n`, 'utf8');
}

async function seedBlogPost(opts: {
  slug: string;
  id: string;
  title: string;
  body: string;
  postedAt: string;
  summary?: string | null;
  deletedAt?: string | null;
}): Promise<void> {
  const fm: Record<string, unknown> = {
    id: opts.id,
    slug: opts.slug,
    title: opts.title,
    postedAt: opts.postedAt,
    createdAt: opts.postedAt,
    updatedAt: opts.postedAt,
  };
  if (opts.summary !== undefined && opts.summary !== null) fm['summary'] = opts.summary;
  if (opts.deletedAt) fm['deletedAt'] = opts.deletedAt;
  await seedRawBlob(
    dataRepo.path,
    `blog-posts/${opts.slug}.md`,
    blogRecord(fm, opts.body),
    `seed blog-posts/${opts.slug}`,
  );
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
});

async function bootApp(): Promise<FastifyInstance> {
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
  return app;
}

describe('GET /api/blog-posts', () => {
  it('returns an empty list when no posts are seeded', async () => {
    const a = await bootApp();
    const res = await a.inject({ method: 'GET', url: '/api/blog-posts' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: true; data: unknown[]; metadata: { totalItems: number } }>();
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.metadata.totalItems).toBe(0);
  });

  it('returns posts sorted by postedAt descending', async () => {
    await seedBlogPost({
      slug: 'older',
      id: UUID_A,
      title: 'Older Post',
      body: 'An older body.',
      postedAt: '2026-04-01T00:00:00Z',
    });
    await seedBlogPost({
      slug: 'newer',
      id: UUID_B,
      title: 'Newer Post',
      body: 'A newer body.',
      postedAt: '2026-05-01T00:00:00Z',
    });

    const a = await bootApp();
    const res = await a.inject({ method: 'GET', url: '/api/blog-posts' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ slug: string; title: string; bodyHtml: string }> }>();
    expect(body.data.map((p) => p.slug)).toEqual(['newer', 'older']);
    // Markdown is rendered server-side per behaviors/markdown-rendering.md.
    expect(body.data[0]!.bodyHtml).toContain('<p>');
  });

  it('excludes soft-deleted posts', async () => {
    await seedBlogPost({
      slug: 'visible',
      id: UUID_A,
      title: 'Visible',
      body: 'visible body',
      postedAt: '2026-04-01T00:00:00Z',
    });
    await seedBlogPost({
      slug: 'hidden',
      id: UUID_B,
      title: 'Hidden',
      body: 'hidden body',
      postedAt: '2026-05-01T00:00:00Z',
      deletedAt: '2026-05-02T00:00:00Z',
    });

    const a = await bootApp();
    const res = await a.inject({ method: 'GET', url: '/api/blog-posts' });
    const body = res.json<{ data: Array<{ slug: string }> }>();
    expect(body.data.map((p) => p.slug)).toEqual(['visible']);
  });

  it('paginates correctly', async () => {
    await seedBlogPost({ slug: 'a', id: UUID_A, title: 'A', body: 'a', postedAt: '2026-03-01T00:00:00Z' });
    await seedBlogPost({ slug: 'b', id: UUID_B, title: 'B', body: 'b', postedAt: '2026-04-01T00:00:00Z' });
    await seedBlogPost({ slug: 'c', id: UUID_C, title: 'C', body: 'c', postedAt: '2026-05-01T00:00:00Z' });

    const a = await bootApp();
    const res = await a.inject({ method: 'GET', url: '/api/blog-posts?page=2&perPage=1' });
    const body = res.json<{ data: Array<{ slug: string }>; metadata: { totalItems: number; totalPages: number } }>();
    expect(body.data.map((p) => p.slug)).toEqual(['b']);
    expect(body.metadata.totalItems).toBe(3);
    expect(body.metadata.totalPages).toBe(3);
  });

  it('filters by `since`', async () => {
    await seedBlogPost({ slug: 'old', id: UUID_A, title: 'Old', body: 'o', postedAt: '2026-01-01T00:00:00Z' });
    await seedBlogPost({ slug: 'new', id: UUID_B, title: 'New', body: 'n', postedAt: '2026-05-01T00:00:00Z' });

    const a = await bootApp();
    const res = await a.inject({ method: 'GET', url: '/api/blog-posts?since=2026-03-01T00:00:00Z' });
    const body = res.json<{ data: Array<{ slug: string }> }>();
    expect(body.data.map((p) => p.slug)).toEqual(['new']);
  });
});

describe('GET /api/blog-posts/:slug', () => {
  it('returns a post by slug with bodyHtml rendered', async () => {
    await seedBlogPost({
      slug: 'civic-tech-roundup',
      id: UUID_A,
      title: 'Civic Tech Roundup',
      body: '# Heading\n\nSome body content.',
      postedAt: '2026-05-01T00:00:00Z',
      summary: 'A short blurb.',
    });

    const a = await bootApp();
    const res = await a.inject({ method: 'GET', url: '/api/blog-posts/civic-tech-roundup' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: true; data: { title: string; summary: string; bodyHtml: string; body: string } }>();
    expect(body.success).toBe(true);
    expect(body.data.title).toBe('Civic Tech Roundup');
    expect(body.data.summary).toBe('A short blurb.');
    expect(body.data.body).toContain('# Heading');
    expect(body.data.bodyHtml).toContain('<p>Some body content.</p>');
  });

  it('returns 404 for unknown slug', async () => {
    const a = await bootApp();
    const res = await a.inject({ method: 'GET', url: '/api/blog-posts/no-such-post' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for soft-deleted post', async () => {
    await seedBlogPost({
      slug: 'gone',
      id: UUID_A,
      title: 'Gone',
      body: 'gone body',
      postedAt: '2026-05-01T00:00:00Z',
      deletedAt: '2026-05-02T00:00:00Z',
    });

    const a = await bootApp();
    const res = await a.inject({ method: 'GET', url: '/api/blog-posts/gone' });
    expect(res.statusCode).toBe(404);
  });
});
