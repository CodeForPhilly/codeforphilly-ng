/**
 * Tests for the person deactivate / reactivate / purge feature.
 *
 * Spec: specs/behaviors/person-lifecycle.md, specs/api/people.md
 *
 * Covers:
 *  - POST /api/people/:slug/deactivate — self
 *  - POST /api/people/:slug/deactivate — staff
 *  - POST /api/people/:slug/deactivate — anonymous → 401
 *  - POST /api/people/:slug/deactivate — other regular user → 403
 *  - Deactivated person hidden from GET /api/people (non-staff)
 *  - Deactivated person 404s GET /api/people/:slug (non-staff)
 *  - Staff can still GET /api/people/:slug for deactivated person
 *  - POST /api/people/:slug/reactivate — self
 *  - POST /api/people/:slug/reactivate — staff
 *  - POST /api/people/:slug/reactivate — anonymous → 401
 *  - POST /api/people/:slug/purge — admin deletes person + authored content
 *  - POST /api/people/:slug/purge — staff (non-admin) → 403
 *  - POST /api/people/:slug/purge — anonymous → 401
 *  - Deactivated reference in project membership renders placeholder
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';

// ---------------------------------------------------------------------------
// Shared fixtures: IDs
// ---------------------------------------------------------------------------

const IDS = {
  alice: '01951a3c-0000-7000-8000-a0000000cafe',
  bob: '01951a3c-0000-7000-8000-b0000000cafe',
  staff: '01951a3c-0000-7000-8000-c0000000cafe',
  admin: '01951a3c-0000-7000-8000-d0000000cafe',
  project: '01951a3c-0000-7000-8000-e0000000cafe',
  membership: '01951a3c-0000-7000-8000-f0000000cafe',
  update: '01951a3c-0000-7000-8000-a1000000cafe',
};

// The session token carries the caller's accountLevel claim, which is what the
// auth guards (isStaff/isAdministrator) read — so it must match the seeded
// person's level. The level arg was previously ignored (hardcoded 'user'),
// which made every staff/admin caller authenticate as a plain user.
async function mintCookies(
  personId: string,
  level: 'user' | 'staff' | 'administrator' = 'user',
): Promise<string> {
  const { accessToken } = await mintSessionFor(personId, level, JWT_KEY);
  return `cfp_session=${accessToken}`;
}

// ---------------------------------------------------------------------------
// Suite: deactivate / reactivate / auth guard
// ---------------------------------------------------------------------------
// Uses a fresh app per describe to allow mutations without leaking state.

describe('POST /api/people/:slug/deactivate', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();

    // Seed four persons
    for (const [slug, id, level] of [
      ['alice', IDS.alice, 'user'],
      ['bob', IDS.bob, 'user'],
      ['staff-user', IDS.staff, 'staff'],
      ['admin-user', IDS.admin, 'administrator'],
    ] as const) {
      const toml = [
        `id = "${id}"`,
        `slug = "${slug}"`,
        `fullName = "Test ${slug}"`,
        `accountLevel = "${level}"`,
        `createdAt = "2026-05-01T00:00:00Z"`,
        `updatedAt = "2026-05-01T00:00:00Z"`,
      ].join('\n');
      await seedRawToml(dataRepo.path, `people/${slug}.toml`, toml, `seed ${slug}`);
    }

    app = await buildApp({
      serverOptions: { logger: false },
      overrideEnv: {
        CFP_DATA_REPO_PATH: dataRepo.path,
        STORAGE_BACKEND: 'filesystem',
        CFP_PRIVATE_STORAGE_PATH: privateStore.path,
        CFP_JWT_SIGNING_KEY: JWT_KEY,
        NODE_ENV: 'test',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('anonymous → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/people/alice/deactivate' });
    expect(res.statusCode).toBe(401);
  });

  it('other regular user → 403', async () => {
    const cookies = await mintCookies(IDS.bob);
    const res = await app.inject({
      method: 'POST',
      url: '/api/people/alice/deactivate',
      headers: { cookie: cookies },
    });
    expect(res.statusCode).toBe(403);
  });

  it('self can deactivate own account', async () => {
    const cookies = await mintCookies(IDS.alice);
    const res = await app.inject({
      method: 'POST',
      url: '/api/people/alice/deactivate',
      headers: { cookie: cookies },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; data: { deletedAt: string | null } }>();
    expect(body.success).toBe(true);
    expect(body.data.deletedAt).not.toBeNull();
  });

  it('deactivated person is excluded from GET /api/people (non-staff)', async () => {
    // alice is already deactivated from the previous test
    const listRes = await app.inject({ method: 'GET', url: '/api/people' });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json<{ data: Array<{ slug: string }> }>();
    expect(list.data.map((p) => p.slug)).not.toContain('alice');
  });

  it('deactivated person 404s GET /api/people/:slug for non-staff', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/api/people/alice' });
    expect(getRes.statusCode).toBe(404);
  });

  it('staff can still GET /api/people/:slug for deactivated person', async () => {
    const cookies = await mintCookies(IDS.staff, 'staff');
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/people/alice',
      headers: { cookie: cookies },
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json<{ data: { deletedAt: string | null } }>();
    expect(body.data.deletedAt).not.toBeNull();
  });
});

describe('POST /api/people/:slug/reactivate', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();

    for (const [slug, id, level] of [
      ['alice', IDS.alice, 'user'],
      ['staff-user', IDS.staff, 'staff'],
    ] as const) {
      const toml = [
        `id = "${id}"`,
        `slug = "${slug}"`,
        `fullName = "Test ${slug}"`,
        `accountLevel = "${level}"`,
        `createdAt = "2026-05-01T00:00:00Z"`,
        `updatedAt = "2026-05-01T00:00:00Z"`,
      ].join('\n');
      await seedRawToml(dataRepo.path, `people/${slug}.toml`, toml, `seed ${slug}`);
    }

    app = await buildApp({
      serverOptions: { logger: false },
      overrideEnv: {
        CFP_DATA_REPO_PATH: dataRepo.path,
        STORAGE_BACKEND: 'filesystem',
        CFP_PRIVATE_STORAGE_PATH: privateStore.path,
        CFP_JWT_SIGNING_KEY: JWT_KEY,
        NODE_ENV: 'test',
      },
    });

    // Deactivate alice first so reactivation tests have something to reactivate
    const staffCookies = await mintCookies(IDS.staff, 'staff');
    await app.inject({
      method: 'POST',
      url: '/api/people/alice/deactivate',
      headers: { cookie: staffCookies },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('anonymous → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/people/alice/reactivate' });
    expect(res.statusCode).toBe(401);
  });

  it('staff can reactivate', async () => {
    const cookies = await mintCookies(IDS.staff, 'staff');
    const res = await app.inject({
      method: 'POST',
      url: '/api/people/alice/reactivate',
      headers: { cookie: cookies },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { deletedAt: string | null } }>();
    expect(body.data.deletedAt).toBeNull();

    // alice visible again in the public list
    const listRes = await app.inject({ method: 'GET', url: '/api/people' });
    const list = listRes.json<{ data: Array<{ slug: string }> }>();
    expect(list.data.map((p) => p.slug)).toContain('alice');
  });

  it('self can reactivate own deactivated account', async () => {
    // Re-deactivate alice as staff first
    const staffCookies = await mintCookies(IDS.staff, 'staff');
    await app.inject({
      method: 'POST',
      url: '/api/people/alice/deactivate',
      headers: { cookie: staffCookies },
    });

    // Alice reactivates herself
    const aliceCookies = await mintCookies(IDS.alice);
    const res = await app.inject({
      method: 'POST',
      url: '/api/people/alice/reactivate',
      headers: { cookie: aliceCookies },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { deletedAt: string | null } }>();
    expect(body.data.deletedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite: purge (admin only)
// ---------------------------------------------------------------------------

describe('POST /api/people/:slug/purge', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();

    for (const [slug, id, level] of [
      ['alice', IDS.alice, 'user'],
      ['staff-user', IDS.staff, 'staff'],
      ['admin-user', IDS.admin, 'administrator'],
    ] as const) {
      const toml = [
        `id = "${id}"`,
        `slug = "${slug}"`,
        `fullName = "Test ${slug}"`,
        `accountLevel = "${level}"`,
        `createdAt = "2026-05-01T00:00:00Z"`,
        `updatedAt = "2026-05-01T00:00:00Z"`,
      ].join('\n');
      await seedRawToml(dataRepo.path, `people/${slug}.toml`, toml, `seed ${slug}`);
    }

    // Seed a project with alice as a member and author of an update
    const projectToml = [
      `id = "${IDS.project}"`,
      `slug = "test-project"`,
      `title = "Test Project"`,
      `stage = "prototyping"`,
      `maintainerId = "${IDS.admin}"`,
      `createdAt = "2026-05-01T00:00:00Z"`,
      `updatedAt = "2026-05-01T00:00:00Z"`,
    ].join('\n');
    await seedRawToml(dataRepo.path, `projects/test-project.toml`, projectToml, 'seed project');

    const membershipToml = [
      `id = "${IDS.membership}"`,
      `projectId = "${IDS.project}"`,
      `projectSlug = "test-project"`,
      `personId = "${IDS.alice}"`,
      `personSlug = "alice"`,
      `isMaintainer = false`,
      `joinedAt = "2026-05-01T00:00:00Z"`,
      `updatedAt = "2026-05-01T00:00:00Z"`,
    ].join('\n');
    await seedRawToml(
      dataRepo.path,
      `project-memberships/test-project/alice.toml`,
      membershipToml,
      'seed membership',
    );

    const updateToml = [
      `id = "${IDS.update}"`,
      `projectId = "${IDS.project}"`,
      `projectSlug = "test-project"`,
      `number = 1`,
      `body = "Alice's update"`,
      `authorId = "${IDS.alice}"`,
      `authorSlug = "alice"`,
      `createdAt = "2026-05-01T00:00:00Z"`,
      `updatedAt = "2026-05-01T00:00:00Z"`,
    ].join('\n');
    await seedRawToml(
      dataRepo.path,
      `project-updates/test-project/1.toml`,
      updateToml,
      'seed update',
    );

    app = await buildApp({
      serverOptions: { logger: false },
      overrideEnv: {
        CFP_DATA_REPO_PATH: dataRepo.path,
        STORAGE_BACKEND: 'filesystem',
        CFP_PRIVATE_STORAGE_PATH: privateStore.path,
        CFP_JWT_SIGNING_KEY: JWT_KEY,
        NODE_ENV: 'test',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('anonymous → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/people/alice/purge' });
    expect(res.statusCode).toBe(401);
  });

  it('staff (non-admin) → 403', async () => {
    const cookies = await mintCookies(IDS.staff, 'staff');
    const res = await app.inject({
      method: 'POST',
      url: '/api/people/alice/purge',
      headers: { cookie: cookies },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin can purge a person — 204 and person gone', async () => {
    const cookies = await mintCookies(IDS.admin, 'administrator');
    const res = await app.inject({
      method: 'POST',
      url: '/api/people/alice/purge',
      headers: { cookie: cookies },
    });
    expect(res.statusCode).toBe(204);

    // alice no longer in list
    const listRes = await app.inject({ method: 'GET', url: '/api/people' });
    const list = listRes.json<{ data: Array<{ slug: string }> }>();
    expect(list.data.map((p) => p.slug)).not.toContain('alice');

    // alice 404s
    const getRes = await app.inject({ method: 'GET', url: '/api/people/alice' });
    expect(getRes.statusCode).toBe(404);
  });

  it('purge cascades — alice membership removed from project', async () => {
    // alice is already purged from the previous test; check project has no alice membership
    const projectRes = await app.inject({ method: 'GET', url: '/api/projects/test-project' });
    expect(projectRes.statusCode).toBe(200);
    const project = projectRes.json<{
      data: { memberships: Array<{ person: { slug: string | null } }> };
    }>();
    const slugs = project.data.memberships.map((m) => m.person.slug);
    expect(slugs).not.toContain('alice');
  });
});

// ---------------------------------------------------------------------------
// Suite: deactivated person placeholder in references
// ---------------------------------------------------------------------------

describe('Deactivated person reference placeholder', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();

    for (const [slug, id, level] of [
      ['alice', IDS.alice, 'user'],
      ['admin-user', IDS.admin, 'administrator'],
    ] as const) {
      const toml = [
        `id = "${id}"`,
        `slug = "${slug}"`,
        `fullName = "Test ${slug}"`,
        `accountLevel = "${level}"`,
        `createdAt = "2026-05-01T00:00:00Z"`,
        `updatedAt = "2026-05-01T00:00:00Z"`,
      ].join('\n');
      await seedRawToml(dataRepo.path, `people/${slug}.toml`, toml, `seed ${slug}`);
    }

    const projectToml = [
      `id = "${IDS.project}"`,
      `slug = "test-project"`,
      `title = "Test Project"`,
      `stage = "prototyping"`,
      `maintainerId = "${IDS.admin}"`,
      `createdAt = "2026-05-01T00:00:00Z"`,
      `updatedAt = "2026-05-01T00:00:00Z"`,
    ].join('\n');
    await seedRawToml(dataRepo.path, `projects/test-project.toml`, projectToml, 'seed project');

    const membershipToml = [
      `id = "${IDS.membership}"`,
      `projectId = "${IDS.project}"`,
      `projectSlug = "test-project"`,
      `personId = "${IDS.alice}"`,
      `personSlug = "alice"`,
      `isMaintainer = false`,
      `joinedAt = "2026-05-01T00:00:00Z"`,
      `updatedAt = "2026-05-01T00:00:00Z"`,
    ].join('\n');
    await seedRawToml(
      dataRepo.path,
      `project-memberships/test-project/alice.toml`,
      membershipToml,
      'seed membership',
    );

    app = await buildApp({
      serverOptions: { logger: false },
      overrideEnv: {
        CFP_DATA_REPO_PATH: dataRepo.path,
        STORAGE_BACKEND: 'filesystem',
        CFP_PRIVATE_STORAGE_PATH: privateStore.path,
        CFP_JWT_SIGNING_KEY: JWT_KEY,
        NODE_ENV: 'test',
      },
    });

    // Deactivate alice
    const { accessToken } = await mintSessionFor(IDS.admin, 'administrator', JWT_KEY);
    await app.inject({
      method: 'POST',
      url: '/api/people/alice/deactivate',
      headers: { cookie: `cfp_session=${accessToken}` },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('deactivated person reference in project membership shows placeholder', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/test-project' });
    expect(res.statusCode).toBe(200);

    type MemberShape = { person: { slug: string | null; fullName: string; deactivated?: boolean } };
    const body = res.json<{ data: { memberships: MemberShape[] } }>();

    // alice should appear as "Deactivated user" placeholder
    const placeholder = body.data.memberships.find(
      (m) => m.person.fullName === 'Deactivated user',
    );
    expect(placeholder).toBeDefined();
    expect(placeholder!.person.slug).toBeNull();
    expect(placeholder!.person.deactivated).toBe(true);
  });
});
