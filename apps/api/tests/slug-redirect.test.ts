/**
 * Tests for the slug-history redirect plugin
 * (apps/api/src/plugins/slug-redirect.ts) — implements
 * specs/behaviors/slug-handles.md → "Mutability and redirects".
 *
 * Covers:
 *  - Single-hop project + person renames → 301 to the new slug
 *  - Sub-route preservation (/projects/old/edit → /projects/new/edit)
 *  - Multi-hop A → B → C in one response
 *  - Live wins (oldSlug is now a different live entity)
 *  - Expired entry → no redirect (request continues)
 *  - Reserved-segment passthrough (/projects/create stays alone)
 *  - Tag rename (namespace preserved)
 *  - /api/* paths never hit the hook
 *  - Query string preserved across redirect
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';
import { slugHistoryKey } from '../src/store/memory/state.js';

const NOW = '2026-05-27T00:00:00Z';
const FUTURE = '2027-05-27T00:00:00Z'; // 1 yr — well past the 90-day window
const PAST = '2025-05-27T00:00:00Z';

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

async function seedPerson(slug: string, id: string): Promise<void> {
  await seedRawToml(
    dataRepo.path,
    `people/${slug}.toml`,
    [
      `id = "${id}"`,
      `slug = "${slug}"`,
      `fullName = "Test ${slug}"`,
      `accountLevel = "user"`,
      `createdAt = "${NOW}"`,
      `updatedAt = "${NOW}"`,
    ].join('\n'),
    `seed person ${slug}`,
  );
}

async function seedProject(slug: string, id: string): Promise<void> {
  await seedRawToml(
    dataRepo.path,
    `projects/${slug}.toml`,
    [
      `id = "${id}"`,
      `slug = "${slug}"`,
      `title = "Test ${slug}"`,
      `stage = "testing"`,
      `featured = false`,
      `createdAt = "${NOW}"`,
      `updatedAt = "${NOW}"`,
    ].join('\n'),
    `seed project ${slug}`,
  );
}

async function seedTag(namespace: string, slug: string, id: string): Promise<void> {
  await seedRawToml(
    dataRepo.path,
    `tags/${namespace}/${slug}.toml`,
    [
      `id = "${id}"`,
      `namespace = "${namespace}"`,
      `slug = "${slug}"`,
      `title = "${slug}"`,
      `createdAt = "${NOW}"`,
      `updatedAt = "${NOW}"`,
    ].join('\n'),
    `seed tag ${namespace}/${slug}`,
  );
}

async function seedSlugHistory(
  entityType: 'project' | 'person' | 'tag',
  oldSlug: string,
  newSlug: string,
  entityId: string,
  expiresAt: string = FUTURE,
): Promise<void> {
  const id = `01951a3c-0000-7000-8000-${Math.random().toString(36).slice(2, 10).padStart(12, '0')}`;
  await seedRawToml(
    dataRepo.path,
    `slug-history/${entityType}/${oldSlug}.toml`,
    [
      `id = "${id}"`,
      `entityType = "${entityType}"`,
      `oldSlug = "${oldSlug}"`,
      `newSlug = "${newSlug}"`,
      `entityId = "${entityId}"`,
      `changedAt = "${NOW}"`,
      `expiresAt = "${expiresAt}"`,
    ].join('\n'),
    `seed slug-history ${entityType} ${oldSlug}→${newSlug}`,
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

describe('slug-redirect plugin', () => {
  it('301s a renamed person /members/<old> → /members/<new>', async () => {
    const id = '01951a3c-0000-7000-8000-000000000101';
    await seedPerson('chris-a', id);
    await seedSlugHistory('person', 'chris', 'chris-a', id);
    app = await bootApp();

    const res = await app.inject({ method: 'GET', url: '/members/chris' });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/members/chris-a');
    expect(res.headers['cache-control']).toContain('max-age=300');
  });

  it('301s a renamed project /projects/<old> → /projects/<new>', async () => {
    const id = '01951a3c-0000-7000-8000-000000000201';
    await seedProject('squadquest-v2', id);
    await seedSlugHistory('project', 'squadquest', 'squadquest-v2', id);
    app = await bootApp();

    const res = await app.inject({ method: 'GET', url: '/projects/squadquest' });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/projects/squadquest-v2');
  });

  it('preserves the path suffix when redirecting', async () => {
    const id = '01951a3c-0000-7000-8000-000000000202';
    await seedProject('new-name', id);
    await seedSlugHistory('project', 'old-name', 'new-name', id);
    app = await bootApp();

    const res = await app.inject({ method: 'GET', url: '/projects/old-name/edit' });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/projects/new-name/edit');
  });

  it('preserves the query string across the redirect', async () => {
    const id = '01951a3c-0000-7000-8000-000000000203';
    await seedProject('renamed', id);
    await seedSlugHistory('project', 'old', 'renamed', id);
    app = await bootApp();

    const res = await app.inject({ method: 'GET', url: '/projects/old?tab=updates&foo=bar' });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/projects/renamed?tab=updates&foo=bar');
  });

  it('follows a multi-hop chain A → B → C in one response', async () => {
    const id = '01951a3c-0000-7000-8000-000000000204';
    await seedProject('c', id);
    // Two slug-history entries on disk; the in-memory map will store both,
    // keyed by `project:a` → b and `project:b` → c.
    await seedSlugHistory('project', 'a', 'b', id);
    await seedSlugHistory('project', 'b', 'c', id);
    app = await bootApp();

    const res = await app.inject({ method: 'GET', url: '/projects/a' });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/projects/c');
  });

  it('does not redirect when the oldSlug is a different live entity (live wins)', async () => {
    // Set up:
    //   project foo (id A) — once was called bar
    //   project bar (id B, different project) — now lives at slug "bar"
    // A request to /projects/bar should serve the *live* project bar, not
    // redirect to foo. The slug-history record exists but live wins.
    const idA = '01951a3c-0000-7000-8000-000000000301';
    const idB = '01951a3c-0000-7000-8000-000000000302';
    await seedProject('foo', idA);
    await seedProject('bar', idB);
    await seedSlugHistory('project', 'bar', 'foo', idA);
    app = await bootApp();

    const res = await app.inject({ method: 'GET', url: '/projects/bar' });
    // Not a 301 — the live entity wins. The SPA fallthrough is the next
    // handler, so we expect either a 200 (SPA HTML) or a 404 (no SPA
    // bundled in tests). Either way, NOT a redirect.
    expect(res.statusCode).not.toBe(301);
  });

  it('skips expired slug-history entries (no redirect, request continues)', async () => {
    const id = '01951a3c-0000-7000-8000-000000000401';
    await seedProject('still-here', id);
    await seedSlugHistory('project', 'ancient', 'still-here', id, PAST);
    app = await bootApp();

    const res = await app.inject({ method: 'GET', url: '/projects/ancient' });
    expect(res.statusCode).not.toBe(301);
  });

  it('lets reserved segments like /projects/create through without redirect', async () => {
    app = await bootApp();
    const res = await app.inject({ method: 'GET', url: '/projects/create' });
    expect(res.statusCode).not.toBe(301);
  });

  it('301s a renamed tag /tags/<namespace>/<old> → /tags/<namespace>/<new>', async () => {
    const id = '01951a3c-0000-7000-8000-000000000501';
    await seedTag('topic', 'transit', id);
    await seedSlugHistory('tag', 'transportation', 'transit', id);
    app = await bootApp();

    const res = await app.inject({ method: 'GET', url: '/tags/topic/transportation' });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/tags/topic/transit');
  });

  it('never intercepts /api/* paths', async () => {
    const id = '01951a3c-0000-7000-8000-000000000601';
    await seedPerson('alive', id);
    await seedSlugHistory('person', 'gone', 'alive', id);
    app = await bootApp();

    // /api/people/<old-slug> is an API path — the slug-history hook must
    // not touch it. Even if the slug is in slug-history, the route handler
    // owns the response (a 404 from the people service, in this case).
    const res = await app.inject({ method: 'GET', url: '/api/people/gone' });
    expect(res.statusCode).not.toBe(301);
  });

  it('builds the slugHistoryKey deterministically', () => {
    expect(slugHistoryKey('project', 'foo')).toBe('project:foo');
    expect(slugHistoryKey('person', 'chris')).toBe('person:chris');
    expect(slugHistoryKey('tag', 'transit')).toBe('tag:transit');
    expect(slugHistoryKey('buzz', 'x')).toBe('buzz:x');
  });
});
