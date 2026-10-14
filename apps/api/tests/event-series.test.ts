/**
 * Event series and agendas — specs/behaviors/events.md#series, #agenda;
 * specs/api/events.md#event-series.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openRepo } from 'gitsheets';

const execFileAsync = promisify(execFile);

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedFixtures, type SeededFixtures } from './helpers/seed-fixtures.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const STAFF_ID = '01951a3c-0000-7000-8000-000000000099';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;
let fixtures: SeededFixtures;

beforeEach(async () => {
  dataRepo = await createFullDataRepo();
  privateStore = await createPrivateStorageDir();
  fixtures = await seedFixtures(dataRepo.path);
  const repo = await openRepo({ gitDir: dataRepo.path });
  await repo.transact(
    { message: 'seed: staff person', author: { name: 'test', email: 'test@cfp.test' } },
    async (tx) => {
      await tx.sheet('people').upsert({
        id: STAFF_ID,
        slug: 'staff-sam',
        fullName: 'Staff Sam',
        accountLevel: 'staff',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      });
    },
  );
  app = await buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataRepo.path,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: JWT_KEY,
      CFP_SITE_HOST: 'codeforphilly.test',
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

async function cookie(personId: string, level: 'user' | 'staff'): Promise<string> {
  return `cfp_session=${(await mintSessionFor(personId, level, JWT_KEY)).accessToken}`;
}
const staff = () => cookie(STAFF_ID, 'staff');
const jane = () => cookie(fixtures.personId, 'user');

async function staffJson(method: 'POST' | 'PATCH', url: string, payload: unknown) {
  return app!.inject({ method, url, headers: { cookie: await staff(), 'content-type': 'application/json' }, payload });
}

function eventBody(daysFromNow: number, extra: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + daysFromNow * DAY);
  start.setUTCHours(23, 0, 0, 0);
  return {
    title: 'Hack Night',
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 2.5 * HOUR).toISOString(),
    ...extra,
  };
}

describe('event series', () => {
  it('is staff-only to create and resolves a slug from the title', async () => {
    const anon = await app!.inject({ method: 'POST', url: '/api/event-series', payload: { title: 'Monthly Hack Nights' } });
    expect(anon.statusCode).toBe(401);
    const user = await app!.inject({
      method: 'POST',
      url: '/api/event-series',
      headers: { cookie: await jane(), 'content-type': 'application/json' },
      payload: { title: 'Monthly Hack Nights' },
    });
    expect(user.statusCode).toBe(403);

    const res = await staffJson('POST', '/api/event-series', { title: 'Monthly Hack Nights', description: 'First **Tuesdays**.' });
    expect(res.statusCode, res.body).toBe(201);
    // Series are markdown-bodied records (specs/behaviors/storage.md#sheet-layout).
    const { stdout: tree } = await execFileAsync('git', ['--git-dir', dataRepo.path, 'ls-tree', '-r', '--name-only', 'main']);
    expect(tree.split('\n')).toContain('event-series/monthly-hack-nights.md');
    expect(res.json().data).toMatchObject({
      slug: 'monthly-hack-nights',
      title: 'Monthly Hack Nights',
      descriptionHtml: expect.stringContaining('<strong>Tuesdays</strong>'),
      upcoming: [],
      past: [],
      permissions: { canEdit: true, canDelete: true },
    });

    const dup = await staffJson('POST', '/api/event-series', { title: 'Monthly Hack Nights' });
    expect(dup.statusCode).toBe(201);
    expect(dup.json().data.slug).toBe('monthly-hack-nights-2');
    const reserved = await staffJson('POST', '/api/event-series', { title: 'x', slug: 'past' });
    expect(reserved.statusCode).toBe(422);
  });

  it('links events, splits them into upcoming and past, and shows "Part of" on the event', async () => {
    await staffJson('POST', '/api/event-series', { title: 'Monthly Hack Nights' });
    const up = await staffJson('POST', '/api/events', eventBody(7, { seriesSlug: 'monthly-hack-nights' }));
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().data.series).toEqual({ slug: 'monthly-hack-nights', title: 'Monthly Hack Nights' });
    const past = await staffJson('POST', '/api/events', eventBody(-30, { seriesSlug: 'monthly-hack-nights' }));
    const draft = await staffJson('POST', '/api/events', eventBody(14, { seriesSlug: 'monthly-hack-nights', status: 'draft' }));

    const anon = await app!.inject({ method: 'GET', url: '/api/event-series/monthly-hack-nights' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json().data.upcoming.map((e: { slug: string }) => e.slug)).toEqual([up.json().data.slug]);
    expect(anon.json().data.past.map((e: { slug: string }) => e.slug)).toEqual([past.json().data.slug]);
    expect(anon.json().data.eventCount).toBe(2);
    expect(anon.json().data.permissions).toEqual({ canEdit: false, canDelete: false });

    const asStaff = await app!.inject({ method: 'GET', url: '/api/event-series/monthly-hack-nights', headers: { cookie: await staff() } });
    expect(asStaff.json().data.upcoming.map((e: { slug: string }) => e.slug).sort()).toEqual(
      [up.json().data.slug, draft.json().data.slug].sort(),
    );

    const list = await app!.inject({ method: 'GET', url: '/api/events' });
    expect(list.json().data[0].series).toEqual({ slug: 'monthly-hack-nights', title: 'Monthly Hack Nights' });

    const unknown = await staffJson('POST', '/api/events', eventBody(3, { seriesSlug: 'nope' }));
    expect(unknown.statusCode).toBe(404);
  });

  it('hides a series with only drafts (or no events) from non-staff', async () => {
    await staffJson('POST', '/api/event-series', { title: 'Secret' });
    await staffJson('POST', '/api/events', eventBody(7, { seriesSlug: 'secret', status: 'draft' }));
    expect((await app!.inject({ method: 'GET', url: '/api/event-series/secret' })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'GET', url: '/api/event-series' })).json().data).toEqual([]);
    const staffList = await app!.inject({ method: 'GET', url: '/api/event-series', headers: { cookie: await staff() } });
    expect(staffList.json().data.map((s: { slug: string }) => s.slug)).toEqual(['secret']);
  });

  it('refuses to delete while events reference it, and deletes once they are reassigned', async () => {
    await staffJson('POST', '/api/event-series', { title: 'Launchpad' });
    const ev = await staffJson('POST', '/api/events', eventBody(7, { seriesSlug: 'launchpad' }));
    const refused = await app!.inject({ method: 'DELETE', url: '/api/event-series/launchpad', headers: { cookie: await staff() } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('has_events');

    const detach = await staffJson('PATCH', `/api/events/${ev.json().data.slug}`, { seriesSlug: null });
    expect(detach.statusCode).toBe(200);
    expect(detach.json().data.series).toBeNull();
    const gone = await app!.inject({ method: 'DELETE', url: '/api/event-series/launchpad', headers: { cookie: await staff() } });
    expect(gone.statusCode).toBe(204);
    expect((await app!.inject({ method: 'GET', url: '/api/event-series/launchpad', headers: { cookie: await staff() } })).statusCode).toBe(404);
  });

  it('renames with slug history and 301s the old series URL', async () => {
    await staffJson('POST', '/api/event-series', { title: 'Hack Nights' });
    await staffJson('POST', '/api/events', eventBody(7, { seriesSlug: 'hack-nights' }));
    const res = await staffJson('PATCH', '/api/event-series/hack-nights', { slug: 'monthly-hack-nights', title: 'Monthly Hack Nights' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.slug).toBe('monthly-hack-nights');
    const redirect = await app!.inject({ method: 'GET', url: '/events/series/hack-nights' });
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers['location']).toBe('/events/series/monthly-hack-nights');
    const ev = await app!.inject({ method: 'GET', url: '/api/events' });
    expect(ev.json().data[0].series.slug).toBe('monthly-hack-nights');
  });
});

describe('agenda', () => {
  it('validates each item against the event range, sorts on write, and renders markdown', async () => {
    const body = eventBody(7);
    const start = new Date(body.startsAt).getTime();
    const outside = await staffJson('POST', '/api/events', {
      ...body,
      agenda: [{ startsAt: new Date(start - HOUR).toISOString(), title: 'Too early' }],
    });
    expect(outside.statusCode).toBe(422);
    expect(outside.json().error.fields).toHaveProperty('agenda.0.startsAt');

    const res = await staffJson('POST', '/api/events', {
      ...body,
      agenda: [
        { startsAt: new Date(start + HOUR).toISOString(), title: 'Hack', description: 'Find a **table**.' },
        { startsAt: body.startsAt, endsAt: new Date(start + 30 * 60 * 1000).toISOString(), title: 'Welcome', venueName: 'Front room' },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const agenda = res.json().data.agenda;
    expect(agenda.map((a: { title: string }) => a.title)).toEqual(['Welcome', 'Hack']);
    expect(agenda[1].descriptionHtml).toContain('<strong>table</strong>');
    expect(agenda[0].venueName).toBe('Front room');

    const ics = await app!.inject({ method: 'GET', url: `/api/events/${res.json().data.slug}/ics` });
    expect(ics.body.replace(/\r\n /g, '')).toContain('Schedule');
    expect(ics.body.replace(/\r\n /g, '')).toContain('Welcome @ Front room');
  });

  it('agenda edits bump nothing and email nobody; the whole array is replaced', async () => {
    const body = eventBody(7);
    const created = await staffJson('POST', '/api/events', { ...body, agenda: [{ startsAt: body.startsAt, title: 'A' }] });
    const slug = created.json().data.slug;
    const edited = await staffJson('PATCH', `/api/events/${slug}`, { agenda: [{ startsAt: body.startsAt, title: 'B' }] });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data.agenda.map((a: { title: string }) => a.title)).toEqual(['B']);
    const ics = await app!.inject({ method: 'GET', url: `/api/events/${slug}/ics` });
    expect(ics.body).toContain('SEQUENCE:0');
  });
});
