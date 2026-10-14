/**
 * Unit tests for the iCalendar builder and the Philadelphia-time formatter —
 * specs/behaviors/events.md#calendar-files and #time.
 */
import { describe, expect, it } from 'vitest';
import type { Event } from '@cfp/shared/schemas';

import { formatCompactRange, formatEventWhen, nyDateString } from '../src/lib/event-time.js';
import {
  buildEventIcs,
  buildFeedIcs,
  googleCalendarUrl,
  icsLocation,
  markdownToPlainText,
} from '../src/lib/ics.js';

const HOST = 'codeforphilly.org';

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: '01951a3c-0000-7000-8000-000000000042',
    slug: '2026-11-03-hack-night',
    title: 'Code for Philly Hack Night',
    description: 'Bring a **laptop**. [Map](https://example.org/map)',
    // 6:00–8:30 PM EST on Tue Nov 3 2026
    startsAt: '2026-11-03T23:00:00.000Z',
    endsAt: '2026-11-04T01:30:00.000Z',
    venueName: 'Indy Hall',
    venueAddress: '709 N 2nd St, Philadelphia, PA 19123',
    status: 'scheduled',
    icsSequence: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T12:34:56.000Z',
    ...overrides,
  } as Event;
}

describe('formatEventWhen', () => {
  const now = new Date('2026-10-13T12:00:00Z');

  it('renders a same-day evening event with one AM/PM suffix and the zone', () => {
    expect(formatEventWhen('2026-11-03T23:00:00Z', '2026-11-04T01:30:00Z', { now })).toBe(
      'Tue, Nov 3 · 6:00–8:30 PM EST',
    );
  });

  it('shows both suffixes when the range crosses noon', () => {
    expect(formatEventWhen('2026-11-14T15:00:00Z', '2026-11-14T18:00:00Z', { now })).toBe(
      'Sat, Nov 14 · 10:00 AM–1:00 PM EST',
    );
  });

  it('uses EDT in summer and spells out multi-day ranges', () => {
    expect(formatEventWhen('2023-03-31T22:00:00Z', '2023-05-11T01:00:00Z', { now })).toBe(
      'Fri, Mar 31, 2023, 6:00 PM – Wed, May 10, 2023, 9:00 PM EDT',
    );
  });

  it('appends the year only outside the current year', () => {
    expect(formatEventWhen('2025-11-04T23:00:00Z', '2025-11-05T01:30:00Z', { now })).toBe(
      'Tue, Nov 4, 2025 · 6:00–8:30 PM EST',
    );
  });

  it('derives the slug date in Philadelphia time, not UTC', () => {
    // 11 PM UTC on Nov 3 is still Nov 3 in Philly; 3 AM UTC on Nov 4 is Nov 3 evening.
    expect(nyDateString('2026-11-03T23:00:00Z')).toBe('2026-11-03');
    expect(nyDateString('2026-11-04T03:00:00Z')).toBe('2026-11-03');
  });

  it('renders compact agenda ranges', () => {
    expect(formatCompactRange('2023-03-31T22:00:00Z', '2023-04-01T01:00:00Z')).toBe('6–9pm');
    expect(formatCompactRange('2023-04-01T13:00:00Z', '2023-04-01T23:00:00Z')).toBe('9am–7pm');
    expect(formatCompactRange('2023-04-04T22:00:00Z', '2023-04-05T00:30:00Z')).toBe('6–8:30pm');
    expect(formatCompactRange('2023-04-04T22:00:00Z', null)).toBe('6pm');
  });
});

describe('buildEventIcs', () => {
  it('emits a PUBLISH calendar with a stable UID, UTC times, and the location', () => {
    const ics = buildEventIcs(event(), HOST);
    expect(ics).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics).toContain('METHOD:PUBLISH');
    expect(ics).toContain('UID:01951a3c-0000-7000-8000-000000000042@codeforphilly.org');
    expect(ics).toContain('SEQUENCE:0');
    expect(ics).toContain('DTSTAMP:20261002T123456Z');
    expect(ics).toContain('DTSTART:20261103T230000Z');
    expect(ics).toContain('DTEND:20261104T013000Z');
    expect(ics).toContain('SUMMARY:Code for Philly Hack Night');
    expect(ics).toContain('LOCATION:Indy Hall\\, 709 N 2nd St\\, Philadelphia\\, PA 19123');
    expect(ics).toContain('URL:https://codeforphilly.org/events/2026-11-03-hack-night');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('marks cancelled events CANCELLED and carries the bumped SEQUENCE', () => {
    const ics = buildEventIcs(event({ status: 'cancelled', icsSequence: 3 }), HOST);
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:3');
  });

  it('strips markdown in DESCRIPTION and appends the canonical URL', () => {
    const ics = buildEventIcs(event(), HOST);
    expect(ics).toContain('DESCRIPTION:Bring a laptop. Map (https://example.org/map)\\n\\nhttps://cod');
  });

  it('folds long lines at 75 octets with a leading space on continuations', () => {
    const ics = buildEventIcs(event({ title: 'x'.repeat(200) }), HOST);
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(ics).toMatch(/SUMMARY:x+\r\n x+/);
  });

  it('falls back to the online URL as LOCATION and omits it when nothing is set', () => {
    expect(icsLocation({ venueName: null, venueAddress: null, onlineUrl: 'https://meet.example' })).toBe(
      'https://meet.example',
    );
    expect(icsLocation({ venueName: null, venueAddress: null, onlineUrl: null })).toBeNull();
    const ics = buildEventIcs(event({ venueName: null, venueAddress: null }), HOST);
    expect(ics).not.toContain('LOCATION:');
  });

  it('includes a plain-text schedule for agenda events', () => {
    const ics = buildEventIcs(
      event({
        startsAt: '2023-03-31T22:00:00Z',
        endsAt: '2023-05-11T01:00:00Z',
        agenda: [
          { startsAt: '2023-03-31T22:00:00Z', endsAt: '2023-04-01T01:00:00Z', title: 'Friday Night Kickoff', venueName: 'City Hall' },
          { startsAt: '2023-04-01T13:00:00Z', endsAt: '2023-04-01T23:00:00Z', title: 'Opening Work Day' },
        ],
      }),
      HOST,
    );
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('Schedule\\n\\nFriday\\, March 31\\n6–9pm — Friday Night Kickoff @ City Hall\\n\\nSaturday\\, April 1\\n9am–7pm — Opening Work Day');
  });
});

describe('buildFeedIcs', () => {
  it('names the calendar and includes one VEVENT per event', () => {
    const ics = buildFeedIcs([event(), event({ id: '01951a3c-0000-7000-8000-000000000043', slug: 'other' })], HOST);
    expect(ics).toContain('X-WR-CALNAME:Code for Philly');
    expect(ics).toContain('X-WR-TIMEZONE:America/New_York');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
});

describe('googleCalendarUrl', () => {
  it('builds the TEMPLATE link with UTC dates and the location', () => {
    const url = new URL(googleCalendarUrl(event(), HOST));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Code for Philly Hack Night');
    expect(url.searchParams.get('dates')).toBe('20261103T230000Z/20261104T013000Z');
    expect(url.searchParams.get('location')).toBe('Indy Hall, 709 N 2nd St, Philadelphia, PA 19123');
    expect(url.searchParams.get('details')).toContain('https://codeforphilly.org/events/2026-11-03-hack-night');
  });
});

describe('markdownToPlainText', () => {
  it('drops headings, emphasis, images and code fences', () => {
    expect(markdownToPlainText('# Title\n\n**bold** _em_ `code`\n\n![x](img.png)\n\n```\nfence\n```\n\n- a\n- b')).toBe(
      'Title\n\nbold em code\n\n• a\n• b',
    );
  });
});
