/**
 * Events + RSVPs — specs/api/events.md, specs/behaviors/events.md.
 *
 * Boots the full app against a seeded data repo. The seeded `jane-doe` is a
 * plain user; a staff person is added here so `permissions` blocks (which
 * read the Person record, not the JWT) reflect a real staff account.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openRepo } from 'gitsheets';

const execFileAsync = promisify(execFile);

/** Every path in the data repo's committed tree. */
async function committedPaths(): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['--git-dir', dataRepo.path, 'ls-tree', '-r', '--name-only', 'main']);
  return stdout.split('\n').filter(Boolean);
}

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedFixtures, type SeededFixtures } from './helpers/seed-fixtures.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const STAFF_ID = '01951a3c-0000-7000-8000-000000000099';
const STAFF_SLUG = 'staff-sam';

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;
let fixtures: SeededFixtures;

async function seedStaff(repoPath: string): Promise<void> {
  const repo = await openRepo({ gitDir: repoPath });
  await repo.transact(
    { message: 'seed: staff person', author: { name: 'test', email: 'test@cfp.test' } },
    async (tx) => {
      await tx.sheet('people').upsert({
        id: STAFF_ID,
        slug: STAFF_SLUG,
        fullName: 'Staff Sam',
        accountLevel: 'staff',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      });
    },
  );
}

beforeEach(async () => {
  dataRepo = await createFullDataRepo();
  privateStore = await createPrivateStorageDir();
  fixtures = await seedFixtures(dataRepo.path);
  await seedStaff(dataRepo.path);
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

async function cookie(personId: string, level: 'user' | 'staff' | 'administrator'): Promise<string> {
  const session = await mintSessionFor(personId, level, JWT_KEY);
  return `cfp_session=${session.accessToken}`;
}
const janeCookie = () => cookie(fixtures.personId, 'user');
const staffCookie = () => cookie(STAFF_ID, 'staff');

/** A hack night `daysFromNow` days out (negative = past), 6–8:30 PM UTC-ish. */
function hackNight(daysFromNow: number, overrides: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  start.setUTCHours(23, 0, 0, 0);
  const end = new Date(start.getTime() + 2.5 * 60 * 60 * 1000);
  return {
    title: 'Code for Philly Hack Night',
    description: 'Bring a laptop.',
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    venueName: 'Indy Hall',
    venueAddress: '709 N 2nd St, Philadelphia, PA 19123',
    ...overrides,
  };
}

async function createEvent(body: Record<string, unknown>): Promise<{ slug: string; id: string }> {
  const res = await app!.inject({
    method: 'POST',
    url: '/api/events',
    headers: { cookie: await staffCookie(), 'content-type': 'application/json' },
    payload: body,
  });
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json().data;
  return { slug: data.slug, id: data.id };
}

async function giveJaneAnEmail(): Promise<void> {
  await app!.store.private.putProfile({
    personId: fixtures.personId,
    email: 'jane@example.org',
    emailRefreshedAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  });
}

// ---------------------------------------------------------------------------

describe('POST /api/events', () => {
  it('rejects anonymous and plain users', async () => {
    const anon = await app!.inject({ method: 'POST', url: '/api/events', payload: hackNight(7) });
    expect(anon.statusCode).toBe(401);
    const user = await app!.inject({
      method: 'POST',
      url: '/api/events',
      headers: { cookie: await janeCookie() },
      payload: hackNight(7),
    });
    expect(user.statusCode).toBe(403);
  });

  it('stores the record under its year with the description as the markdown body', async () => {
    // gitsheets normalizes the body's trailing newline away; everything
    // before it comes back byte-for-byte.
    const description = '# Agenda\n\n- Bring a laptop.\n- Say hi!\n\nSee **you** there.';
    const body = hackNight(7, { description });
    const { slug } = await createEvent(body);
    expect(await committedPaths()).toContain(`events/${body.startsAt.slice(0, 4)}/${slug}.md`);
    // Round trip: the stored body comes back as the description, unchanged.
    const detail = await app!.inject({ method: 'GET', url: `/api/events/${slug}`, headers: { cookie: await staffCookie() } });
    expect(detail.json().data.description).toBe(description);
    expect(detail.json().data.descriptionHtml).toContain('<strong>you</strong>');
  });

  it('creates a scheduled event with a date-first default slug and staff permissions', async () => {
    const body = hackNight(7);
    const res = await app!.inject({
      method: 'POST',
      url: '/api/events',
      headers: { cookie: await staffCookie() },
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data;
    expect(data.slug).toMatch(/^\d{4}-\d{2}-\d{2}-code-for-philly-hack-night$/);
    expect(data.status).toBe('scheduled');
    expect(data.rsvpCount).toBe(0);
    expect(data.viewerRsvp).toBeNull();
    expect(data.descriptionHtml).toContain('Bring a laptop');
    expect(data.icsUrl).toBe(`/api/events/${data.slug}/ics`);
    expect(data.permissions).toEqual({
      canRsvp: true,
      canEdit: true,
      canPublish: false,
      canCancel: true,
      canDelete: true,
    });
    expect(data).not.toHaveProperty('icsSequence');
    expect(data).not.toHaveProperty('reminders');
  });

  it('validates the time range, URLs, and reserved slugs', async () => {
    const bad = await app!.inject({
      method: 'POST',
      url: '/api/events',
      headers: { cookie: await staffCookie() },
      payload: hackNight(7, { endsAt: hackNight(7).startsAt, meetupUrl: 'https://example.org/x' }),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.fields).toMatchObject({ endsAt: 'must be after startsAt' });
    expect(bad.json().error.fields.meetupUrl).toBeDefined();

    const reserved = await app!.inject({
      method: 'POST',
      url: '/api/events',
      headers: { cookie: await staffCookie() },
      payload: hackNight(7, { slug: 'past' }),
    });
    expect(reserved.statusCode).toBe(422);
  });

  it('refuses a taken slug with 409 slug_taken', async () => {
    await createEvent(hackNight(7, { slug: 'hack-night' }));
    const dup = await app!.inject({
      method: 'POST',
      url: '/api/events',
      headers: { cookie: await staffCookie() },
      payload: hackNight(14, { slug: 'hack-night' }),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('slug_taken');
  });
});

describe('GET /api/events', () => {
  it('lists upcoming by end time ascending, past descending, and hides drafts from non-staff', async () => {
    const far = await createEvent(hackNight(30, { title: 'Far' }));
    const near = await createEvent(hackNight(3, { title: 'Near' }));
    const old = await createEvent(hackNight(-3, { title: 'Old' }));
    const older = await createEvent(hackNight(-30, { title: 'Older' }));
    const draft = await createEvent(hackNight(10, { title: 'Draft', status: 'draft' }));

    const upcoming = await app!.inject({ method: 'GET', url: '/api/events' });
    expect(upcoming.json().data.map((e: { slug: string }) => e.slug)).toEqual([near.slug, far.slug]);

    const past = await app!.inject({ method: 'GET', url: '/api/events?when=past' });
    expect(past.json().data.map((e: { slug: string }) => e.slug)).toEqual([old.slug, older.slug]);

    const staffAll = await app!.inject({
      method: 'GET',
      url: '/api/events?when=all',
      headers: { cookie: await staffCookie() },
    });
    expect(staffAll.json().data.map((e: { slug: string }) => e.slug)).toContain(draft.slug);
    expect(staffAll.json().metadata.totalItems).toBe(5);

    const anonDraft = await app!.inject({ method: 'GET', url: `/api/events/${draft.slug}` });
    expect(anonDraft.statusCode).toBe(404);
    const staffDraft = await app!.inject({
      method: 'GET',
      url: `/api/events/${draft.slug}`,
      headers: { cookie: await staffCookie() },
    });
    expect(staffDraft.statusCode).toBe(200);
    expect(staffDraft.json().data.permissions.canPublish).toBe(true);
  });

  it('rejects unknown when/sort values', async () => {
    expect((await app!.inject({ method: 'GET', url: '/api/events?when=soon' })).statusCode).toBe(422);
    expect((await app!.inject({ method: 'GET', url: '/api/events?sort=title' })).statusCode).toBe(422);
  });
});

describe('RSVP', () => {
  it('requires sign-in', async () => {
    const { slug } = await createEvent(hackNight(7));
    const res = await app!.inject({ method: 'PUT', url: `/api/events/${slug}/rsvp` });
    expect(res.statusCode).toBe(401);
  });

  it('creates once (201), updates the follow-up (200), never duplicates, and withdraws', async () => {
    await giveJaneAnEmail();
    const spy = vi.spyOn(app!.notifier, 'notifyEventRsvp');
    const { slug } = await createEvent(hackNight(7));
    const jane = await janeCookie();

    const first = await app!.inject({ method: 'PUT', url: `/api/events/${slug}/rsvp`, headers: { cookie: jane } });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data).toMatchObject({ rsvpCount: 1, confirmationDelivered: true });
    expect(first.json().data.rsvp.person.slug).toBe(fixtures.personSlug);
    expect(first.json().data.rsvp.plan).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0]![0];
    expect(payload.email).toBe('jane@example.org');
    expect(payload.ics).toContain('BEGIN:VEVENT');
    expect(payload.googleCalendarUrl).toContain('calendar.google.com');
    expect(payload.event.url).toBe(`https://codeforphilly.test/events/${slug}`);

    const again = await app!.inject({
      method: 'PUT',
      url: `/api/events/${slug}/rsvp`,
      headers: { cookie: jane, 'content-type': 'application/json' },
      payload: { plan: 'newcomer' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ rsvpCount: 1, confirmationDelivered: null });
    expect(again.json().data.rsvp.plan).toBe('newcomer');
    expect(spy).toHaveBeenCalledTimes(1);

    const detail = await app!.inject({ method: 'GET', url: `/api/events/${slug}`, headers: { cookie: jane } });
    expect(detail.json().data.viewerRsvp).toMatchObject({ plan: 'newcomer', project: null });
    expect(detail.json().data.rsvpCount).toBe(1);

    const list = await app!.inject({ method: 'GET', url: `/api/events/${slug}/rsvps` });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].person.fullName).toBe('Jane Doe');

    const withdraw = await app!.inject({ method: 'DELETE', url: `/api/events/${slug}/rsvp`, headers: { cookie: jane } });
    expect(withdraw.statusCode).toBe(204);
    const withdrawAgain = await app!.inject({ method: 'DELETE', url: `/api/events/${slug}/rsvp`, headers: { cookie: jane } });
    expect(withdrawAgain.statusCode).toBe(204);
    const after = await app!.inject({ method: 'GET', url: `/api/events/${slug}` });
    expect(after.json().data.rsvpCount).toBe(0);
  });

  it('stores a project plan, clears it for other plans, and 422s a project plan without a slug', async () => {
    const { slug } = await createEvent(hackNight(7));
    const jane = await janeCookie();
    const withProject = await app!.inject({
      method: 'PUT',
      url: `/api/events/${slug}/rsvp`,
      headers: { cookie: jane, 'content-type': 'application/json' },
      payload: { plan: 'project', projectSlug: fixtures.projectSlug },
    });
    expect(withProject.statusCode).toBe(201);
    expect(withProject.json().data.rsvp).toMatchObject({ plan: 'project', project: { slug: fixtures.projectSlug } });

    // The project Jane named now leads her picker on *other* events
    // (viewerRecentProjects, specs/api/events.md); not on this one, and
    // never for anonymous callers.
    const other = await createEvent(hackNight(14));
    const otherDetail = await app!.inject({ method: 'GET', url: `/api/events/${other.slug}`, headers: { cookie: jane } });
    expect(otherDetail.json().data.viewerRecentProjects).toEqual([{ slug: fixtures.projectSlug, title: expect.any(String) }]);
    const sameDetail = await app!.inject({ method: 'GET', url: `/api/events/${slug}`, headers: { cookie: jane } });
    expect(sameDetail.json().data.viewerRecentProjects).toEqual([]);
    const anonDetail = await app!.inject({ method: 'GET', url: `/api/events/${other.slug}` });
    expect(anonDetail.json().data.viewerRecentProjects).toEqual([]);
    // Every caller sees the active projects: the last ten distinct ones anyone
    // named on any RSVP, this event's included.
    expect(anonDetail.json().data.recentProjects).toEqual([{ slug: fixtures.projectSlug, title: expect.any(String) }]);
    expect(sameDetail.json().data.recentProjects).toEqual([{ slug: fixtures.projectSlug, title: expect.any(String) }]);

    const noSlug = await app!.inject({
      method: 'PUT',
      url: `/api/events/${slug}/rsvp`,
      headers: { cookie: jane, 'content-type': 'application/json' },
      payload: { plan: 'project' },
    });
    expect(noSlug.statusCode).toBe(422);

    const unknownProject = await app!.inject({
      method: 'PUT',
      url: `/api/events/${slug}/rsvp`,
      headers: { cookie: jane, 'content-type': 'application/json' },
      payload: { plan: 'project', projectSlug: 'nope' },
    });
    expect(unknownProject.statusCode).toBe(404);

    const cleared = await app!.inject({
      method: 'PUT',
      url: `/api/events/${slug}/rsvp`,
      headers: { cookie: jane, 'content-type': 'application/json' },
      payload: { plan: 'no_project' },
    });
    expect(cleared.json().data.rsvp).toMatchObject({ plan: 'no_project', project: null });
  });

  it('answers 409 rsvp_closed for ended, cancelled, and draft events', async () => {
    const jane = await janeCookie();
    const ended = await createEvent(hackNight(-2));
    const cancelled = await createEvent(hackNight(5));
    await app!.inject({ method: 'POST', url: `/api/events/${cancelled.slug}/cancel`, headers: { cookie: await staffCookie() } });
    for (const slug of [ended.slug, cancelled.slug]) {
      const res = await app!.inject({ method: 'PUT', url: `/api/events/${slug}/rsvp`, headers: { cookie: jane } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('rsvp_closed');
    }
    const draft = await createEvent(hackNight(5, { status: 'draft' }));
    const asUser = await app!.inject({ method: 'PUT', url: `/api/events/${draft.slug}/rsvp`, headers: { cookie: jane } });
    expect(asUser.statusCode).toBe(404);
    const asStaff = await app!.inject({ method: 'PUT', url: `/api/events/${draft.slug}/rsvp`, headers: { cookie: await staffCookie() } });
    expect(asStaff.statusCode).toBe(409);

    const withdrawEnded = await app!.inject({ method: 'DELETE', url: `/api/events/${ended.slug}/rsvp`, headers: { cookie: jane } });
    expect(withdrawEnded.statusCode).toBe(409);
  });

  it('reports permissions.canRsvp honestly', async () => {
    const { slug } = await createEvent(hackNight(7));
    const anon = await app!.inject({ method: 'GET', url: `/api/events/${slug}` });
    expect(anon.json().data.permissions.canRsvp).toBe(false);
    const jane = await app!.inject({ method: 'GET', url: `/api/events/${slug}`, headers: { cookie: await janeCookie() } });
    expect(jane.json().data.permissions).toMatchObject({ canRsvp: true, canEdit: false, canCancel: false });
  });
});

describe('PATCH /api/events/:slug', () => {
  it('bumps SEQUENCE and emails attendees when the time changes, but not for a description edit', async () => {
    await giveJaneAnEmail();
    const updated = vi.spyOn(app!.notifier, 'notifyEventUpdated');
    const { slug } = await createEvent(hackNight(7));
    await app!.inject({ method: 'PUT', url: `/api/events/${slug}/rsvp`, headers: { cookie: await janeCookie() } });

    const descr = await app!.inject({
      method: 'PATCH',
      url: `/api/events/${slug}`,
      headers: { cookie: await staffCookie(), 'content-type': 'application/json' },
      payload: { description: 'New words.' },
    });
    expect(descr.statusCode).toBe(200);
    let ics = await app!.inject({ method: 'GET', url: `/api/events/${slug}/ics` });
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.body).toContain('SEQUENCE:0');
    expect(updated).not.toHaveBeenCalled();

    const newStart = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();
    const newEnd = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString();
    const time = await app!.inject({
      method: 'PATCH',
      url: `/api/events/${slug}`,
      headers: { cookie: await staffCookie(), 'content-type': 'application/json' },
      payload: { startsAt: newStart, endsAt: newEnd },
    });
    expect(time.statusCode, time.body).toBe(200);
    await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
    expect(updated.mock.calls[0]![0].changes.map((c) => c.field).sort()).toEqual(['endsAt', 'startsAt']);
    ics = await app!.inject({ method: 'GET', url: `/api/events/${slug}/ics` });
    expect(ics.body).toContain('SEQUENCE:1');
    expect(ics.headers['content-disposition']).toBe(`attachment; filename="${slug}.ics"`);
  });

  it('renames the slug, moves RSVP files and images, writes slug history, and 301s the old URL', async () => {
    const year = hackNight(7).startsAt.slice(0, 4);
    const { slug, id } = await createEvent(
      hackNight(7, { slug: 'hack-night-old', description: `![flyer](/api/attachments/events/${year}/hack-night-old/flyer.png)` }),
    );
    await app!.inject({ method: 'PUT', url: `/api/events/${slug}/rsvp`, headers: { cookie: await janeCookie() } });
    await app!.store.public.transact(
      { message: 'test: attach flyer', author: { name: 'test', email: 'test@cfp.test' } },
      async (tx) => {
        await tx.events.setAttachments({ slug, startsAt: hackNight(7).startsAt } as never, { 'flyer.png': Buffer.from('PNG') });
      },
    );

    const res = await app!.inject({
      method: 'PATCH',
      url: `/api/events/${slug}`,
      headers: { cookie: await staffCookie(), 'content-type': 'application/json' },
      payload: { slug: 'hack-night-new' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.slug).toBe('hack-night-new');

    const rsvps = await app!.inject({ method: 'GET', url: '/api/events/hack-night-new/rsvps' });
    expect(rsvps.json().data).toHaveLength(1);
    // The committed tree moved the RSVP file under the new slug (direct
    // gitsheets reads are cached after a transact, so inspect git itself).
    const tree = await committedPaths();
    expect(tree).toContain(`events/${year}/hack-night-new/flyer.png`);
    expect(tree).not.toContain(`events/${year}/hack-night-old/flyer.png`);
    expect(res.json().data.descriptionHtml).toContain(`/api/attachments/events/${year}/hack-night-new/flyer.png`);
    expect(tree).toContain(`event-rsvps/${year}/hack-night-new/${fixtures.personSlug}.toml`);
    expect(tree).not.toContain(`event-rsvps/${year}/hack-night-old/${fixtures.personSlug}.toml`);
    expect(tree).toContain(`events/${year}/hack-night-new.md`);
    expect(tree).not.toContain(`events/${year}/hack-night-old.md`);
    expect(tree).toContain('slug-history/event/hack-night-old.toml');
    expect(app!.inMemoryState.eventIdBySlug.get('hack-night-new')).toBe(id);

    const redirect = await app!.inject({ method: 'GET', url: '/events/hack-night-old' });
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers['location']).toBe('/events/hack-night-new');
    expect((await app!.inject({ method: 'GET', url: '/api/events/hack-night-old' })).statusCode).toBe(404);
  });

  it('moves the event and RSVP files when startsAt crosses a year boundary', async () => {
    // Dec 31 23:00Z → Jan 1 01:00Z: the partition year changes, the slug
    // does not (specs/behaviors/storage.md#sheet-layout).
    const y = new Date().getUTCFullYear() + 1;
    const { slug } = await createEvent(
      hackNight(7, { slug: 'nye-hack', startsAt: `${y}-12-31T23:00:00.000Z`, endsAt: `${y + 1}-01-01T02:00:00.000Z` }),
    );
    await app!.inject({ method: 'PUT', url: `/api/events/${slug}/rsvp`, headers: { cookie: await janeCookie() } });
    let tree = await committedPaths();
    expect(tree).toContain(`events/${y}/nye-hack.md`);
    expect(tree).toContain(`event-rsvps/${y}/nye-hack/${fixtures.personSlug}.toml`);

    const res = await app!.inject({
      method: 'PATCH',
      url: `/api/events/${slug}`,
      headers: { cookie: await staffCookie(), 'content-type': 'application/json' },
      payload: { startsAt: `${y + 1}-01-01T01:00:00.000Z`, endsAt: `${y + 1}-01-01T03:00:00.000Z` },
    });
    expect(res.statusCode, res.body).toBe(200);
    tree = await committedPaths();
    expect(tree).toContain(`events/${y + 1}/nye-hack.md`);
    expect(tree).not.toContain(`events/${y}/nye-hack.md`);
    expect(tree).toContain(`event-rsvps/${y + 1}/nye-hack/${fixtures.personSlug}.toml`);
    expect(tree).not.toContain(`event-rsvps/${y}/nye-hack/${fixtures.personSlug}.toml`);
    expect(tree).not.toContain('slug-history/event/nye-hack.toml');
    expect((await app!.inject({ method: 'GET', url: `/api/events/${slug}/rsvps` })).json().data).toHaveLength(1);
  });

  it('refuses status changes via PATCH', async () => {
    const { slug } = await createEvent(hackNight(7));
    const res = await app!.inject({
      method: 'PATCH',
      url: `/api/events/${slug}`,
      headers: { cookie: await staffCookie(), 'content-type': 'application/json' },
      payload: { status: 'draft' },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('publish / cancel / delete', () => {
  it('publishes a draft once', async () => {
    const { slug } = await createEvent(hackNight(7, { status: 'draft' }));
    const first = await app!.inject({ method: 'POST', url: `/api/events/${slug}/publish`, headers: { cookie: await staffCookie() } });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.status).toBe('scheduled');
    const again = await app!.inject({ method: 'POST', url: `/api/events/${slug}/publish`, headers: { cookie: await staffCookie() } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('not_draft');
  });

  it('cancels with a note, keeps RSVPs, emails attendees with STATUS:CANCELLED', async () => {
    await giveJaneAnEmail();
    const cancelledSpy = vi.spyOn(app!.notifier, 'notifyEventCancelled');
    const { slug } = await createEvent(hackNight(7));
    await app!.inject({ method: 'PUT', url: `/api/events/${slug}/rsvp`, headers: { cookie: await janeCookie() } });

    const res = await app!.inject({
      method: 'POST',
      url: `/api/events/${slug}/cancel`,
      headers: { cookie: await staffCookie(), 'content-type': 'application/json' },
      payload: { note: 'Snow day.' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'cancelled', cancellationNote: 'Snow day.', rsvpCount: 1 });
    expect(res.json().data.cancelledAt).toBeTruthy();
    await vi.waitFor(() => expect(cancelledSpy).toHaveBeenCalledTimes(1));
    expect(cancelledSpy.mock.calls[0]![0].note).toBe('Snow day.');
    expect(cancelledSpy.mock.calls[0]![0].ics).toContain('STATUS:CANCELLED');

    const again = await app!.inject({ method: 'POST', url: `/api/events/${slug}/cancel`, headers: { cookie: await staffCookie() } });
    expect(again.json().error.code).toBe('not_scheduled');

    // Cancelled events stay listed and visible.
    const list = await app!.inject({ method: 'GET', url: '/api/events' });
    expect(list.json().data[0]).toMatchObject({ slug, status: 'cancelled' });
  });

  it('refuses to delete an event with RSVPs and deletes a draft outright', async () => {
    const { slug } = await createEvent(hackNight(7));
    await app!.inject({ method: 'PUT', url: `/api/events/${slug}/rsvp`, headers: { cookie: await janeCookie() } });
    const refused = await app!.inject({ method: 'DELETE', url: `/api/events/${slug}`, headers: { cookie: await staffCookie() } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('has_rsvps');
    const detail = await app!.inject({ method: 'GET', url: `/api/events/${slug}`, headers: { cookie: await staffCookie() } });
    expect(detail.json().data.permissions.canDelete).toBe(false);

    const draft = await createEvent(hackNight(9, { status: 'draft' }));
    const gone = await app!.inject({ method: 'DELETE', url: `/api/events/${draft.slug}`, headers: { cookie: await staffCookie() } });
    expect(gone.statusCode).toBe(204);
    expect((await app!.inject({ method: 'GET', url: `/api/events/${draft.slug}`, headers: { cookie: await staffCookie() } })).statusCode).toBe(404);
  });
});

describe('calendar feed and legacy URLs', () => {
  it('serves scheduled and cancelled events in the feed, never drafts', async () => {
    const live = await createEvent(hackNight(7, { title: 'Live' }));
    const draft = await createEvent(hackNight(8, { title: 'Draft', status: 'draft' }));
    const ancient = await createEvent(hackNight(-200, { title: 'Ancient' }));
    const res = await app!.inject({ method: 'GET', url: '/api/events/feed.ics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toContain('X-WR-CALNAME:Code for Philly');
    expect(res.body).toContain(`/events/${live.slug}`);
    expect(res.body).not.toContain(`/events/${draft.slug}`);
    expect(res.body).not.toContain(`/events/${ancient.slug}`);
  });

  it('301s /calendar and the laddr list views and segment URLs', async () => {
    const cases: Array<[string, string]> = [
      ['/calendar', '/events'],
      ['/events/*past', '/events/past'],
      ['/events/*upcoming', '/events'],
      ['/events/*all', '/events'],
      ['/events/launchpad-2023/segments/friday_night_kickoff-2023', '/events/series/launchpad-2023'],
      // laddr's handles map statically to slug-form series slugs.
      ['/events/launchpad_2019/segments/OpeningWorkDay', '/events/series/launchpad-2019'],
      ['/events/datahack2020/segments/hack-night', '/events/series/data-hack-2020'],
    ];
    for (const [from, to] of cases) {
      const res = await app!.inject({ method: 'GET', url: from });
      expect(res.statusCode, from).toBe(301);
      expect(res.headers['location'], from).toBe(to);
    }
  });
});

describe('person purge', () => {
  it('removes the purged person\'s RSVPs', async () => {
    const { slug } = await createEvent(hackNight(7));
    await app!.inject({ method: 'PUT', url: `/api/events/${slug}/rsvp`, headers: { cookie: await janeCookie() } });
    const purge = await app!.inject({
      method: 'POST',
      url: `/api/people/${fixtures.personSlug}/purge`,
      headers: { cookie: await cookie(STAFF_ID, 'administrator') },
    });
    expect(purge.statusCode, purge.body).toBe(204);
    const detail = await app!.inject({ method: 'GET', url: `/api/events/${slug}` });
    expect(detail.json().data.rsvpCount).toBe(0);
    expect(await committedPaths()).not.toContain(`event-rsvps/${slug.slice(0, 4)}/${slug}/${fixtures.personSlug}.toml`);
  });
});
