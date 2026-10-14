/**
 * Event reminder sweep — specs/behaviors/events.md#reminders.
 *
 * `dueReminder` is a pure function tested against a table; the service is
 * exercised through a booted app with a stubbed clock passed to `sweep()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openRepo } from 'gitsheets';
import type { Event } from '@cfp/shared/schemas';

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { dueReminder, SWEEP_INTERVAL_MS } from '../src/services/event-reminders.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedFixtures, type SeededFixtures } from './helpers/seed-fixtures.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = new Date('2026-11-03T23:00:00Z');

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: '01951a3c-0000-7000-8000-000000000042',
    slug: 'hack-night',
    title: 'Hack Night',
    startsAt: START.toISOString(),
    endsAt: new Date(START.getTime() + 2 * HOUR).toISOString(),
    status: 'scheduled',
    icsSequence: 0,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  } as Event;
}

const at = (msBeforeStart: number) => new Date(START.getTime() - msBeforeStart);

describe('dueReminder', () => {
  it.each([
    ['8 days out', at(8 * DAY), null],
    ['exactly 7 days out', at(7 * DAY), 'week'],
    ['6.5 days out', at(6.5 * DAY), 'week'],
    ['6 days out (band closed)', at(6 * DAY), null],
    ['3 days out (created late: no week reminder)', at(3 * DAY), null],
    ['exactly 24h out', at(24 * HOUR), 'day'],
    ['20h out', at(20 * HOUR), 'day'],
    ['18h out (band closed)', at(18 * HOUR), null],
    ['12h out', at(12 * HOUR), null],
    ['after start', at(-HOUR), null],
  ])('%s → %s', (_label, now, expected) => {
    expect(dueReminder(event(), now)).toBe(expected);
  });

  it('never fires twice, for cancelled events, or for drafts', () => {
    expect(dueReminder(event({ reminders: { weekSentAt: '2026-10-27T23:00:00Z' } }), at(6.5 * DAY))).toBeNull();
    expect(dueReminder(event({ reminders: { daySentAt: '2026-11-02T23:00:00Z' } }), at(20 * HOUR))).toBeNull();
    expect(dueReminder(event({ status: 'cancelled' }), at(20 * HOUR))).toBeNull();
    expect(dueReminder(event({ status: 'draft' }), at(6.5 * DAY))).toBeNull();
  });

  it('sends the day reminder even if the week reminder was skipped', () => {
    expect(dueReminder(event(), at(20 * HOUR))).toBe('day');
  });
});

// ---------------------------------------------------------------------------

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const STAFF_ID = '01951a3c-0000-7000-8000-000000000099';
const EXTRA_PEOPLE = [
  { id: '01951a3c-0000-7000-8000-000000000101', slug: 'bob', fullName: 'Bob Builder' },
  { id: '01951a3c-0000-7000-8000-000000000102', slug: 'cat', fullName: 'Cat Coder' },
] as const;

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;
let fixtures: SeededFixtures;

async function buildTestApp(env: Record<string, string> = {}): Promise<FastifyInstance> {
  return buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataRepo.path,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: JWT_KEY,
      NODE_ENV: 'test',
      ...env,
    },
  });
}

beforeEach(async () => {
  dataRepo = await createFullDataRepo();
  privateStore = await createPrivateStorageDir();
  fixtures = await seedFixtures(dataRepo.path);
  const repo = await openRepo({ gitDir: dataRepo.path });
  await repo.transact(
    { message: 'seed: staff + extra members', author: { name: 'test', email: 'test@cfp.test' } },
    async (tx) => {
      await tx.sheet('people').upsert({
        id: STAFF_ID,
        slug: 'staff-sam',
        fullName: 'Staff Sam',
        accountLevel: 'staff',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      });
      for (const p of EXTRA_PEOPLE) {
        await tx.sheet('people').upsert({
          ...p,
          accountLevel: 'user',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        });
      }
    },
  );
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

async function cookie(personId: string, level: 'user' | 'staff'): Promise<string> {
  return `cfp_session=${(await mintSessionFor(personId, level, JWT_KEY)).accessToken}`;
}

async function scheduledEvent(startsAt: Date): Promise<string> {
  const res = await app!.inject({
    method: 'POST',
    url: '/api/events',
    headers: { cookie: await cookie(STAFF_ID, 'staff'), 'content-type': 'application/json' },
    payload: {
      title: 'Hack Night',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 2 * HOUR).toISOString(),
      venueName: 'Indy Hall',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.slug as string;
}

async function rsvpAs(personId: string, email: string, slug: string, plan?: string): Promise<void> {
  await app!.store.private.putProfile({
    personId,
    email,
    emailRefreshedAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  });
  const res = await app!.inject({
    method: 'PUT',
    url: `/api/events/${slug}/rsvp`,
    headers: { cookie: await cookie(personId, 'user'), 'content-type': 'application/json' },
    payload: plan ? { plan, projectSlug: fixtures.projectSlug } : {},
  });
  expect(res.statusCode, res.body).toBe(201);
}

const rsvpJane = (slug: string, plan?: string) => rsvpAs(fixtures.personId, 'jane@example.org', slug, plan);

describe('EventReminderService.sweep', () => {
  it('sends the week reminder once per attendee and records it before sending', async () => {
    const start = new Date(Date.now() + 6.9 * DAY);
    const slug = await scheduledEvent(start);
    await rsvpJane(slug, 'project');
    await rsvpAs(EXTRA_PEOPLE[0].id, 'bob@example.org', slug, 'newcomer');
    await rsvpAs(EXTRA_PEOPLE[1].id, 'cat@example.org', slug);
    const spy = vi.spyOn(app!.notifier, 'notifyEventReminder');

    const first = await app!.eventReminders.sweep(new Date(start.getTime() - 6.8 * DAY));
    expect(first).toEqual({ events: 1, sent: 3 });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((c) => c[0].email).sort()).toEqual(['bob@example.org', 'cat@example.org', 'jane@example.org']);
    const jane = spy.mock.calls.find((c) => c[0].email === 'jane@example.org')![0];
    expect(jane).toMatchObject({ kind: 'week', fullName: 'Jane Doe' });
    expect(jane.planLine).toContain('SquadQuest');
    expect(jane.event.url).toContain(`/events/${slug}`);
    expect(spy.mock.calls.find((c) => c[0].email === 'bob@example.org')![0].planLine).toContain('new to Code for Philly');
    expect(spy.mock.calls.find((c) => c[0].email === 'cat@example.org')![0].planLine).toBeNull();

    const record = app!.services.events.findBySlug(slug)!;
    expect(record.reminders?.weekSentAt).toBeTruthy();
    expect(record.reminders?.daySentAt).toBeUndefined();

    const second = await app!.eventReminders.sweep(new Date(start.getTime() - 6.5 * DAY));
    expect(second).toEqual({ events: 0, sent: 0 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('runs every five minutes outside tests and stops on close', async () => {
    await app!.close();
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { EventReminderService } = await import('../src/services/event-reminders.js');
    const sweepSpy = vi.spyOn(EventReminderService.prototype, 'sweep');
    app = await buildTestApp({ NODE_ENV: 'development' });
    await app.ready();
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    const idx = setSpy.mock.calls.findIndex((c) => c[1] === SWEEP_INTERVAL_MS);
    expect(idx).toBeGreaterThanOrEqual(0);
    const handle = setSpy.mock.results[idx]!.value;
    await app.close();
    app = undefined;
    expect(clearSpy.mock.calls.some((c) => c[0] === handle)).toBe(true);
  });

  it('skips the week band when the pod missed it and still sends the day reminder', async () => {
    const start = new Date(Date.now() + 10 * DAY);
    const slug = await scheduledEvent(start);
    await rsvpJane(slug);
    const spy = vi.spyOn(app!.notifier, 'notifyEventReminder');

    expect(await app!.eventReminders.sweep(new Date(start.getTime() - 5 * DAY))).toEqual({ events: 0, sent: 0 });
    expect(await app!.eventReminders.sweep(new Date(start.getTime() - 20 * HOUR))).toEqual({ events: 1, sent: 1 });
    expect(spy.mock.calls[0]![0].kind).toBe('day');
    expect(spy.mock.calls[0]![0].planLine).toBeNull();
  });

  it('never reminds for cancelled events or those without RSVPs, and skips attendees without email', async () => {
    const start = new Date(Date.now() + 10 * DAY);
    const slug = await scheduledEvent(start);
    const spy = vi.spyOn(app!.notifier, 'notifyEventReminder');

    // No RSVPs: the event is still marked (so it won't be re-checked) but nothing is sent.
    expect(await app!.eventReminders.sweep(new Date(start.getTime() - 6.9 * DAY))).toEqual({ events: 1, sent: 0 });

    // Attendee without a profile email is skipped.
    await app!.inject({
      method: 'PUT',
      url: `/api/events/${slug}/rsvp`,
      headers: { cookie: await cookie(fixtures.personId, 'user') },
    });
    expect(await app!.eventReminders.sweep(new Date(start.getTime() - 20 * HOUR))).toEqual({ events: 1, sent: 0 });
    expect(spy).not.toHaveBeenCalled();

    const cancelled = await scheduledEvent(new Date(Date.now() + 20 * DAY));
    await app!.inject({ method: 'POST', url: `/api/events/${cancelled}/cancel`, headers: { cookie: await cookie(STAFF_ID, 'staff') } });
    const cancelledStart = new Date(app!.services.events.findBySlug(cancelled)!.startsAt);
    expect(await app!.eventReminders.sweep(new Date(cancelledStart.getTime() - 6.9 * DAY))).toEqual({ events: 0, sent: 0 });
  });

  it('keeps the bookkeeping commit when the notifier throws (at-most-once)', async () => {
    const start = new Date(Date.now() + 10 * DAY);
    const slug = await scheduledEvent(start);
    await rsvpJane(slug);
    vi.spyOn(app!.notifier, 'notifyEventReminder').mockRejectedValue(new Error('postmark down'));

    const result = await app!.eventReminders.sweep(new Date(start.getTime() - 6.9 * DAY));
    expect(result).toEqual({ events: 1, sent: 1 });
    expect(app!.services.events.findBySlug(slug)!.reminders?.weekSentAt).toBeTruthy();
    expect(await app!.eventReminders.sweep(new Date(start.getTime() - 6.5 * DAY))).toEqual({ events: 0, sent: 0 });
  });
});
