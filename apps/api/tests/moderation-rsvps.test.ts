/**
 * Event RSVPs in the moderation footprint — specs/api/moderation.md →
 * GET /api/admin/members (footprint.rsvps) and GET /api/admin/members/:slug
 * (footprint.rsvps); issue #266.
 *
 * Covers:
 *  - the detail lists a member's RSVPs, newest first, past and cancelled events included
 *  - a member with no RSVPs gets an empty list, and another member's RSVP never shows
 *  - each item carries only the event's slug, title and startsAt, and createdAt
 *  - an agent caller with moderation:read sees the same list as staff
 *  - the roster row counts RSVPs, and RSVPs alone do not set `has-footprint`
 *  - a new RSVP shows on the roster and in the detail at once (in-memory index)
 *
 * Every name here is invented; none is a real member's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bearer,
  createAgent,
  daysAgo,
  fid,
  personRecord,
  privateProfile,
  startAgentTestEnv,
  type AgentTestEnv,
  type Rec,
} from './helpers/agent-fixtures.js';

const ADMIN = 1;
const STAFF = 2;
const VOLUNTEER = 10;
const EMPTY = 11;
const OTHER = 12;
const LATE = 13;

const DAY = 86_400_000;
const daysFromNow = (d: number): string => new Date(Date.now() + d * DAY).toISOString();
const yearOf = (iso: string): string => String(new Date(iso).getUTCFullYear());

function event(n: number, slug: string, title: string, startsAt: string, over: Rec = {}): Rec {
  const endsAt = new Date(Date.parse(startsAt) + 2 * 60 * 60 * 1000).toISOString();
  return {
    id: fid(n),
    slug,
    title,
    startsAt,
    endsAt,
    status: 'scheduled',
    icsSequence: 0,
    createdAt: daysAgo(90),
    updatedAt: daysAgo(90),
    ...over,
  };
}

function rsvp(n: number, ev: Rec, personSlug: string, createdAt: string, over: Rec = {}): Rec {
  return {
    id: fid(n),
    year: yearOf(ev['startsAt'] as string),
    eventSlug: ev['slug'],
    personSlug,
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
}

interface RsvpItem {
  event: { slug: string; title: string; startsAt: string };
  createdAt: string;
}
interface Row {
  slug: string;
  footprint: Record<string, number>;
  signals: string[];
}
interface Detail {
  footprint: { rsvps: RsvpItem[] } & Record<string, unknown>;
}

describe('moderation footprint: event RSVPs', () => {
  let env: AgentTestEnv;
  let staff: string;
  let reader: { token: string };

  const past = event(100, 'june-hack-night', 'June Hack Night', '2025-06-10T22:00:00.000Z');
  const cancelled = event(101, 'cancelled-workshop', 'Cancelled Workshop', '2025-09-15T22:00:00.000Z', {
    status: 'cancelled',
    cancelledAt: '2025-09-01T00:00:00.000Z',
  });
  const upcoming = event(102, 'next-hack-night', 'Next Hack Night', daysFromNow(7));
  const later = event(103, 'later-hack-night', 'Later Hack Night', daysFromNow(14));
  const upcomingRsvpAt = daysAgo(3);

  beforeAll(async () => {
    env = await startAgentTestEnv({
      records: {
        people: [
          personRecord(ADMIN, 'boss', { accountLevel: 'administrator' }),
          personRecord(STAFF, 'staffer', { accountLevel: 'staff' }),
          personRecord(VOLUNTEER, 'quiet-volunteer', { createdAt: daysAgo(20), bio: 'Here for hack nights.' }),
          personRecord(EMPTY, 'empty-account', { createdAt: daysAgo(2) }),
          personRecord(OTHER, 'other-member', { createdAt: daysAgo(300) }),
          personRecord(LATE, 'late-rsvper', { createdAt: daysAgo(1) }),
        ],
        events: [past, cancelled, upcoming, later],
        'event-rsvps': [
          rsvp(200, past, 'quiet-volunteer', '2025-06-01T12:00:00.000Z', { plan: 'newcomer' }),
          rsvp(201, cancelled, 'quiet-volunteer', '2025-08-20T12:00:00.000Z'),
          rsvp(202, upcoming, 'quiet-volunteer', upcomingRsvpAt),
          rsvp(203, upcoming, 'other-member', daysAgo(4)),
        ],
      },
      profiles: [privateProfile(fid(VOLUNTEER), 'quiet.volunteer@example.org')],
    });
    const admin = await env.cookie(ADMIN, 'administrator');
    staff = await env.cookie(STAFF, 'staff');
    reader = await createAgent(env, admin, { slug: 'reader-bot', scopes: ['moderation:read'] });
  }, 90_000);

  afterAll(async () => {
    await env.close();
  });

  const asStaff = (): Record<string, unknown> => ({ cookies: { cfp_session: staff } });

  const detail = async (slug: string, auth: Record<string, unknown> = asStaff()): Promise<Detail> => {
    const res = await env.app.inject({ method: 'GET', url: `/api/admin/members/${slug}`, ...auth });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ data: Detail }>().data;
  };

  const roster = async (auth: Record<string, unknown> = asStaff()): Promise<Row[]> => {
    const res = await env.app.inject({ method: 'GET', url: '/api/admin/members?perPage=200', ...auth });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ data: Row[] }>().data;
  };

  it('lists a member\'s RSVPs newest first, past and cancelled events included', async () => {
    const d = await detail('quiet-volunteer');
    expect(d.footprint.rsvps).toEqual([
      { event: { slug: 'next-hack-night', title: 'Next Hack Night', startsAt: upcoming['startsAt'] }, createdAt: upcomingRsvpAt },
      { event: { slug: 'cancelled-workshop', title: 'Cancelled Workshop', startsAt: '2025-09-15T22:00:00.000Z' }, createdAt: '2025-08-20T12:00:00.000Z' },
      { event: { slug: 'june-hack-night', title: 'June Hack Night', startsAt: '2025-06-10T22:00:00.000Z' }, createdAt: '2025-06-01T12:00:00.000Z' },
    ]);
  });

  it('carries only the event reference and when the RSVP was made', async () => {
    const d = await detail('quiet-volunteer');
    for (const item of d.footprint.rsvps) {
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'event']);
      expect(Object.keys(item.event).sort()).toEqual(['slug', 'startsAt', 'title']);
    }
    // The follow-up answer and the RSVP id stay out of it.
    const body = JSON.stringify(d.footprint.rsvps);
    expect(body).not.toContain('newcomer');
    expect(body).not.toContain(fid(200));
  });

  it('gives a member with no RSVPs an empty list, and never shows another member\'s RSVP', async () => {
    expect((await detail('empty-account')).footprint.rsvps).toEqual([]);
    const other = await detail('other-member');
    expect(other.footprint.rsvps.map((r) => r.event.slug)).toEqual(['next-hack-night']);
  });

  it('shows an agent caller with moderation:read the same RSVPs as staff, without the email', async () => {
    const asAgent = await detail('quiet-volunteer', bearer(reader.token));
    const asStaffMember = await detail('quiet-volunteer');
    expect(asAgent.footprint.rsvps).toEqual(asStaffMember.footprint.rsvps);
    expect(JSON.stringify(asAgent)).not.toContain('quiet.volunteer@example.org');

    const agentRow = (await roster(bearer(reader.token))).find((r) => r.slug === 'quiet-volunteer')!;
    expect(agentRow.footprint['rsvps']).toBe(3);
  });

  it('counts RSVPs on the roster row; RSVPs alone do not set has-footprint', async () => {
    const rows = await roster();
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    expect(bySlug.get('quiet-volunteer')!.footprint['rsvps']).toBe(3);
    expect(bySlug.get('other-member')!.footprint['rsvps']).toBe(1);
    expect(bySlug.get('empty-account')!.footprint['rsvps']).toBe(0);
    expect(bySlug.get('quiet-volunteer')!.signals).not.toContain('has-footprint');
  });

  it('shows a new RSVP on the roster and in the detail at once', async () => {
    const lateCookie = await env.cookie(LATE, 'user');
    const before = (await roster()).find((r) => r.slug === 'late-rsvper')!;
    expect(before.footprint['rsvps']).toBe(0);

    const put = await env.app.inject({
      method: 'PUT',
      url: '/api/events/later-hack-night/rsvp',
      cookies: { cfp_session: lateCookie },
    });
    expect(put.statusCode, put.body).toBeLessThan(300);

    const after = (await roster()).find((r) => r.slug === 'late-rsvper')!;
    expect(after.footprint['rsvps']).toBe(1);
    const d = await detail('late-rsvper');
    expect(d.footprint.rsvps.map((r) => r.event)).toEqual([
      { slug: 'later-hack-night', title: 'Later Hack Night', startsAt: later['startsAt'] },
    ]);
  });
});

