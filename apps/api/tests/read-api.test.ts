/**
 * Tests for the read-api plan validation criteria.
 *
 * Covers:
 *  - GET /api/projects returns shape + metadata.facets
 *  - GET /api/projects?stage=testing&tag=tech.flutter filters correctly
 *  - GET /api/projects?q=squad returns via FTS
 *  - GET /api/projects/:slug returns full Project shape
 *  - GET /api/projects/nope returns 404
 *  - GET /api/people, GET /api/people/:slug
 *  - GET /api/tags, GET /api/tags/:handle, GET /api/tags/:handle/projects, /people
 *  - GET /api/projects/:slug/updates[/:number], /api/project-updates
 *  - GET /api/projects/:slug/buzz, /api/project-buzz
 *  - GET /api/projects/:slug/help-wanted, /api/help-wanted
 *  - Pagination: ?page=2&perPage=1
 *  - Sort: ?sort=-updatedAt honored; unknown sort key → 422
 *  - Markdown fields come back as HTML
 *  - permissions block present on project detail
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedFixtures, type SeededFixtures } from './helpers/seed-fixtures.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;
let fixtures: SeededFixtures;

async function buildTestApp(dataPath = dataRepo.path): Promise<FastifyInstance> {
  return buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataPath,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
      NODE_ENV: 'test',
    },
  });
}

beforeEach(async () => {
  dataRepo = await createFullDataRepo();
  privateStore = await createPrivateStorageDir();
  fixtures = await seedFixtures(dataRepo.path);
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
// Helper
// ---------------------------------------------------------------------------

function json<T>(res: Awaited<ReturnType<FastifyInstance['inject']>>): T {
  return res.json<T>();
}

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

describe('GET /api/projects', () => {
  it('returns 200 with success envelope and facets', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);

    const body = json<{
      success: boolean;
      data: unknown[];
      metadata: { page: number; perPage: number; totalItems: number; totalPages: number; facets: unknown };
    }>(res);

    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.metadata.totalItems).toBe('number');
    expect(typeof body.metadata.facets).toBe('object');
  });

  it('returns the seeded project in the list', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects' });
    const body = json<{ data: Array<{ slug: string; title: string }> }>(res);

    const found = body.data.find((p) => p.slug === fixtures.projectSlug);
    expect(found).toBeDefined();
    expect(found?.title).toBe('SquadQuest');
  });

  it('filters by stage', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects?stage=testing' });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Array<{ slug: string; stage: string }> }>(res);
    expect(body.data.every((p) => p.stage === 'testing')).toBe(true);
    expect(body.data.some((p) => p.slug === fixtures.projectSlug)).toBe(true);
  });

  it('filters by tag; selected tag is pinned into its namespace facet', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/projects?tag=${fixtures.tagHandle}`,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{
      data: Array<{ slug: string }>;
      metadata: { facets: { byTech: Array<{ tag: string; count: number }> } };
    }>(res);

    // Filtered data contains our project
    expect(body.data.some((p) => p.slug === fixtures.projectSlug)).toBe(true);
    // Per the self-exclusion rule, byTech is computed over projects
    // filtered by every criterion EXCEPT tech tags — the selected tag
    // is still in the list (either naturally in the top 10 or pinned).
    expect(body.metadata.facets.byTech.some((f) => f.tag === fixtures.tagHandle)).toBe(true);
  });

  it('?q= returns matching projects via FTS', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects?q=SquadQuest' });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Array<{ slug: string }> }>(res);
    expect(body.data.some((p) => p.slug === fixtures.projectSlug)).toBe(true);
  });

  it('pagination: ?page=2&perPage=1 returns empty since only 1 project', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects?page=2&perPage=1' });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: unknown[]; metadata: { page: number; totalItems: number } }>(res);
    expect(body.data).toHaveLength(0);
    expect(body.metadata.page).toBe(2);
    expect(body.metadata.totalItems).toBe(1);
  });

  it('?sort=-updatedAt is honored (default)', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects?sort=-updatedAt' });
    expect(res.statusCode).toBe(200);
  });

  it('unknown sort key → 422 validation_failed', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects?sort=unknown' });
    expect(res.statusCode).toBe(422);
    const body = json<{ success: boolean; error: { code: string } }>(res);
    expect(body.error.code).toBe('validation_failed');
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:slug
// ---------------------------------------------------------------------------

describe('GET /api/projects/:slug', () => {
  it('returns the full project shape', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/projects/${fixtures.projectSlug}`,
    });
    expect(res.statusCode).toBe(200);

    const body = json<{
      success: boolean;
      data: {
        id: string;
        slug: string;
        title: string;
        overviewHtml: string;
        memberships: unknown[];
        tags: { topic: unknown[]; tech: unknown[]; event: unknown[] };
        counts: { updates: number; buzz: number; members: number };
        permissions: {
          canEdit: boolean;
          canManageMembers: boolean;
          canPostUpdate: boolean;
          canLogBuzz: boolean;
          canPostHelpWanted: boolean;
          canDelete: boolean;
        };
      };
    }>(res);

    expect(body.success).toBe(true);
    expect(body.data.slug).toBe(fixtures.projectSlug);
    expect(body.data.title).toBe('SquadQuest');

    // overviewHtml should be rendered HTML
    expect(body.data.overviewHtml).toContain('<h');

    // memberships should include the seeded member
    expect(body.data.memberships.length).toBeGreaterThan(0);

    // tags should have the flutter tag
    expect(body.data.tags.tech.length).toBeGreaterThan(0);

    // counts
    expect(body.data.counts.updates).toBe(1);
    expect(body.data.counts.buzz).toBe(1);
    expect(body.data.counts.members).toBe(1);

    // permissions block (anonymous caller)
    expect(typeof body.data.permissions.canEdit).toBe('boolean');
    expect(body.data.permissions.canEdit).toBe(false); // anonymous
    expect(body.data.permissions.canDelete).toBe(false);
  });

  it('returns 404 for unknown slug', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects/nope' });
    expect(res.statusCode).toBe(404);
    const body = json<{ success: boolean; error: { code: string } }>(res);
    expect(body.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// GET /api/people
// ---------------------------------------------------------------------------

describe('GET /api/people', () => {
  it('returns 200 with people list and facets', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/people' });
    expect(res.statusCode).toBe(200);
    const body = json<{
      success: boolean;
      data: Array<{ slug: string; fullName: string }>;
      metadata: { facets: unknown };
    }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.metadata.facets).toBe('object');
    expect(body.data.some((p) => p.slug === fixtures.personSlug)).toBe(true);
  });

  it('unknown sort key → 422', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/people?sort=unknown' });
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /api/people/:slug', () => {
  it('returns the person detail shape', async () => {
    const res = await app!.inject({ method: 'GET', url: `/api/people/${fixtures.personSlug}` });
    expect(res.statusCode).toBe(200);

    const body = json<{
      data: {
        slug: string;
        fullName: string;
        bioHtml: string;
        memberships: unknown[];
        permissions: { canEdit: boolean };
      };
    }>(res);

    expect(body.data.slug).toBe(fixtures.personSlug);
    expect(body.data.fullName).toBe('Jane Doe');
    expect(body.data.bioHtml).toContain('<p>');
    expect(body.data.memberships.length).toBeGreaterThan(0);
    expect(typeof body.data.permissions.canEdit).toBe('boolean');
  });

  it('exposes slackHandle to anonymous callers (public field)', async () => {
    const res = await app!.inject({ method: 'GET', url: `/api/people/${fixtures.personSlug}` });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: { slackHandle: string | null } }>(res);
    expect(body.data.slackHandle).toBe('jane-doe');
  });

  it('does NOT expose email to anonymous callers', async () => {
    const res = await app!.inject({ method: 'GET', url: `/api/people/${fixtures.personSlug}` });
    const body = json<{ data: { email: string | null } }>(res);
    expect(body.data.email).toBeNull();
  });

  it('returns 404 for unknown slug', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/people/nobody' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/tags
// ---------------------------------------------------------------------------

describe('GET /api/tags', () => {
  it('returns 200 with tag list including the seeded tag', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/tags' });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Array<{ handle: string; namespace: string; slug: string }> }>(res);
    expect(body.data.some((t) => t.handle === fixtures.tagHandle)).toBe(true);
  });

  it('unknown sort key → 422', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/tags?sort=unknown' });
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /api/tags/:handle', () => {
  it('returns the tag', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/tags/${fixtures.tagHandle}`,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: { handle: string; projectCount: number } }>(res);
    expect(body.data.handle).toBe(fixtures.tagHandle);
    expect(body.data.projectCount).toBeGreaterThan(0);
  });

  it('returns 404 for unknown handle', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/tags/nope.nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/tags/:handle/projects', () => {
  it('returns projects tagged with this tag', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/tags/${fixtures.tagHandle}/projects`,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Array<{ slug: string }> }>(res);
    expect(body.data.some((p) => p.slug === fixtures.projectSlug)).toBe(true);
  });
});

describe('GET /api/tags/:handle/people', () => {
  it('returns people tagged with this tag', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/tags/${fixtures.tagHandle}/people`,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Array<{ slug: string }> }>(res);
    expect(body.data.some((p) => p.slug === fixtures.personSlug)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:slug/updates
// ---------------------------------------------------------------------------

describe('GET /api/projects/:slug/updates', () => {
  it('returns the list of updates with bodyHtml', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/projects/${fixtures.projectSlug}/updates`,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Array<{ number: number; bodyHtml: string }> }>(res);
    expect(body.data.some((u) => u.number === 1)).toBe(true);
    const update = body.data.find((u) => u.number === 1);
    expect(update?.bodyHtml).toContain('<p>');
  });

  it('returns 404 for unknown project', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects/nope/updates' });
    expect(res.statusCode).toBe(404);
  });

  it('unknown sort key → 422', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/projects/${fixtures.projectSlug}/updates?sort=unknown`,
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /api/projects/:slug/updates/:number', () => {
  it('returns a specific update', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/projects/${fixtures.projectSlug}/updates/1`,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: { number: number; bodyHtml: string; permissions: unknown } }>(res);
    expect(body.data.number).toBe(1);
    expect(typeof body.data.permissions).toBe('object');
  });

  it('returns 404 for unknown update number', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/projects/${fixtures.projectSlug}/updates/999`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/project-updates', () => {
  it('returns global update feed', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/project-updates' });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Array<{ id: string }> }>(res);
    expect(body.data.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:slug/buzz
// ---------------------------------------------------------------------------

describe('GET /api/projects/:slug/buzz', () => {
  it('returns buzz items', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/projects/${fixtures.projectSlug}/buzz`,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Array<{ slug: string; headline: string }> }>(res);
    expect(body.data.some((b) => b.slug === 'inquirer-praises-squadquest')).toBe(true);
  });

  it('returns 404 for unknown project', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects/nope/buzz' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/project-buzz', () => {
  it('returns global buzz feed', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/project-buzz' });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Array<{ id: string }> }>(res);
    expect(body.data.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:slug/help-wanted
// ---------------------------------------------------------------------------

describe('GET /api/projects/:slug/help-wanted', () => {
  it('returns help-wanted roles with descriptionHtml and permissions', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/projects/${fixtures.projectSlug}/help-wanted`,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{
      data: Array<{
        id: string;
        title: string;
        status: string;
        descriptionHtml: string;
        permissions: unknown;
      }>;
    }>(res);
    expect(body.data.some((r) => r.id === fixtures.helpWantedId)).toBe(true);
    const role = body.data.find((r) => r.id === fixtures.helpWantedId);
    expect(role?.status).toBe('open');
    expect(role?.descriptionHtml).toContain('<p>');
    expect(typeof role?.permissions).toBe('object');
  });

  it('returns 404 for unknown project', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/projects/nope/help-wanted' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/help-wanted', () => {
  it('returns global help-wanted browse with facets', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/help-wanted' });
    expect(res.statusCode).toBe(200);
    const body = json<{
      data: Array<{ id: string }>;
      metadata: { facets: { byTech: unknown[]; byTopic: unknown[] } };
    }>(res);
    expect(body.data.some((r) => r.id === fixtures.helpWantedId)).toBe(true);
    expect(typeof body.metadata.facets).toBe('object');
  });

  it('?q= returns matching roles via FTS', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/help-wanted?q=Flutter' });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Array<{ id: string }> }>(res);
    expect(body.data.some((r) => r.id === fixtures.helpWantedId)).toBe(true);
  });

  it('unknown sort key → 422', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/help-wanted?sort=unknown' });
    expect(res.statusCode).toBe(422);
  });
});
