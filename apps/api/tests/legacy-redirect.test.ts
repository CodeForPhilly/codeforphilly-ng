/**
 * Tests for the legacy laddr URL redirect plugin
 * (apps/api/src/plugins/legacy-redirect.ts) — implements
 * specs/behaviors/legacy-id-mapping.md → "Legacy URL forms we accept".
 *
 * Covers all 5 redirect patterns + the /checkin /bigscreen 410 + the
 * /api/* bypass + unknown-legacyId pass-through.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const NOW = '2026-05-27T00:00:00Z';

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

async function seedProject(slug: string, id: string, legacyId?: number): Promise<void> {
  const lines = [
    `id = "${id}"`,
    `slug = "${slug}"`,
    `title = "Test ${slug}"`,
    `stage = "testing"`,
    `featured = false`,
    `createdAt = "${NOW}"`,
    `updatedAt = "${NOW}"`,
  ];
  if (legacyId !== undefined) lines.push(`legacyId = ${legacyId}`);
  await seedRawToml(
    dataRepo.path,
    `projects/${slug}.toml`,
    lines.join('\n'),
    `seed project ${slug}`,
  );
}

async function seedBuzz(opts: {
  projectId: string;
  projectSlug: string;
  buzzId: string;
  buzzSlug: string;
}): Promise<void> {
  await seedRawToml(
    dataRepo.path,
    `project-buzz/${opts.projectSlug}/${opts.buzzSlug}.toml`,
    [
      `id = "${opts.buzzId}"`,
      `projectId = "${opts.projectId}"`,
      `slug = "${opts.buzzSlug}"`,
      `headline = "Test buzz ${opts.buzzSlug}"`,
      `url = "https://example.com/${opts.buzzSlug}"`,
      `publishedAt = "${NOW}"`,
      `createdAt = "${NOW}"`,
      `updatedAt = "${NOW}"`,
    ].join('\n'),
    `seed buzz ${opts.buzzSlug}`,
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

describe('legacy-redirect plugin', () => {
  describe('/projects?ID=<n>', () => {
    it('301s to /projects/<slug>', async () => {
      const id = '01951a3c-0000-7000-8000-000000000301';
      await seedProject('my-project', id, 42);
      app = await bootApp();

      const res = await app.inject({ method: 'GET', url: '/projects?ID=42' });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/projects/my-project');
    });

    it('preserves other query params, drops ID from the result', async () => {
      const id = '01951a3c-0000-7000-8000-000000000302';
      await seedProject('mp', id, 7);
      app = await bootApp();

      const res = await app.inject({ method: 'GET', url: '/projects?ID=7&tab=updates' });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/projects/mp?tab=updates');
    });

    it('passes through unknown legacyIds (no redirect)', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/projects?ID=99999' });
      expect(res.statusCode).not.toBe(301);
    });

    it('passes through non-numeric ID values', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/projects?ID=notanumber' });
      expect(res.statusCode).not.toBe(301);
    });
  });

  describe('/people/:username', () => {
    it('301s to /members/:username', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/people/janedoe' });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/members/janedoe');
    });

    it('preserves sub-routes', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/people/janedoe/edit' });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/members/janedoe/edit');
    });

    it('preserves query string', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/people/janedoe?tab=projects' });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/members/janedoe?tab=projects');
    });
  });

  describe('/project-updates?ProjectID=<n>', () => {
    it('301s to /projects/<slug>', async () => {
      const id = '01951a3c-0000-7000-8000-000000000401';
      await seedProject('updates-target', id, 11);
      app = await bootApp();

      const res = await app.inject({ method: 'GET', url: '/project-updates?ProjectID=11' });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/projects/updates-target');
    });

    it('passes through unknown legacyIds', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/project-updates?ProjectID=99' });
      expect(res.statusCode).not.toBe(301);
    });
  });

  describe('/project-buzz/<slug>', () => {
    it('301s to /projects/<projectSlug>/buzz/<slug>', async () => {
      const projectId = '01951a3c-0000-7000-8000-000000000501';
      const buzzId = '01951a3c-0000-7000-8000-000000000502';
      await seedProject('news-project', projectId, undefined);
      await seedBuzz({
        projectId,
        projectSlug: 'news-project',
        buzzId,
        buzzSlug: 'press-mention',
      });
      app = await bootApp();

      const res = await app.inject({ method: 'GET', url: '/project-buzz/press-mention' });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/projects/news-project/buzz/press-mention');
    });

    it('passes through unknown buzz slugs', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/project-buzz/nonexistent' });
      expect(res.statusCode).not.toBe(301);
    });
  });

  describe('/tags/<namespace>.<slug>', () => {
    it('301s topic.* to /tags/topic/*', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/tags/topic.transit' });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/tags/topic/transit');
    });

    it('301s tech.* to /tags/tech/*', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/tags/tech.flutter' });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/tags/tech/flutter');
    });

    it('301s event.* to /tags/event/*', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/tags/event.ecocamp-2014' });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/tags/event/ecocamp-2014');
    });

    it('does not match /tags/topic/transit (already path-form)', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/tags/topic/transit' });
      expect(res.statusCode).not.toBe(301);
    });
  });

  describe('410 Gone for deferred patterns', () => {
    it('serves 410 for /checkin', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/checkin' });
      expect(res.statusCode).toBe(410);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('no longer available');
    });

    it('serves 410 for /bigscreen', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/bigscreen' });
      expect(res.statusCode).toBe(410);
    });
  });

  describe('/api/* bypass', () => {
    it('does not intercept /api/projects', async () => {
      const id = '01951a3c-0000-7000-8000-000000000901';
      await seedProject('apitest', id, 42);
      app = await bootApp();

      // /api/projects with a real legacyId-style query — never 301s.
      // (The actual API route handles its own routing; this confirms the
      // legacy-redirect hook stays out of the API surface.)
      const res = await app.inject({ method: 'GET', url: '/api/projects?ID=42' });
      expect(res.statusCode).not.toBe(301);
    });

    it('does not intercept /api/people/:username (no /members rewrite for API)', async () => {
      app = await bootApp();
      const res = await app.inject({ method: 'GET', url: '/api/people/janedoe' });
      expect(res.statusCode).not.toBe(301);
    });
  });
});
