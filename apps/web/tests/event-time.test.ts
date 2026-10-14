import { describe, expect, it } from 'vitest';
import {
  addMinutesToWallClock,
  agendaDayHeading,
  eventDateBlock,
  eventMonthHeading,
  formatCompactRange,
  formatEventTime,
  formatEventTimeOnly,
  googleCalendarUrl,
  phillyWallClockToUtc,
  shiftOneMonthInPhilly,
  utcToPhillyWallClock,
} from '../src/lib/event-time.js';

const NOW_2026 = new Date('2026-10-13T12:00:00Z');

describe('formatEventTime', () => {
  it('formats a same-day event in Philly time with the zone abbreviation', () => {
    // 2026-11-03 18:00 EST = 23:00Z
    expect(formatEventTime('2026-11-03T23:00:00Z', '2026-11-04T01:30:00Z', { now: NOW_2026 })).toBe(
      'Tue, Nov 3 · 6:00–8:30 PM EST',
    );
  });

  it('uses EDT in summer', () => {
    expect(formatEventTime('2026-07-07T22:00:00Z', '2026-07-08T00:30:00Z', { now: NOW_2026 })).toBe(
      'Tue, Jul 7 · 6:00–8:30 PM EDT',
    );
  });

  it('carries both meridiems when a same-day range crosses noon', () => {
    expect(formatEventTimeOnly('2026-11-07T16:00:00Z', '2026-11-07T18:00:00Z')).toBe('11:00 AM–1:00 PM EST');
  });

  it('formats a multi-day event', () => {
    expect(formatEventTime('2026-03-31T22:00:00Z', '2026-05-11T01:00:00Z', { now: NOW_2026 })).toBe(
      'Tue, Mar 31, 6:00 PM – Sun, May 10, 9:00 PM EDT',
    );
  });

  it('appends the year only outside the current year', () => {
    expect(formatEventTime('2025-11-04T23:00:00Z', '2025-11-05T01:30:00Z', { now: NOW_2026 })).toBe(
      'Tue, Nov 4, 2025 · 6:00–8:30 PM EST',
    );
  });

  it('long style spells out weekday and month', () => {
    expect(
      formatEventTime('2026-11-03T23:00:00Z', '2026-11-04T01:30:00Z', { style: 'long', now: NOW_2026 }),
    ).toBe('Tuesday, November 3 · 6:00–8:30 PM EST');
  });

  it('ignores the browser zone (a UTC-late time stays on the Philly date)', () => {
    // 23:00Z on Nov 3 is still Nov 3 in Philly, though Nov 4 in UTC+2.
    expect(eventDateBlock('2026-11-03T23:00:00Z')).toEqual({ dow: 'Tue', day: '3', mon: 'Nov' });
  });
});

describe('list helpers', () => {
  it('month heading', () => {
    expect(eventMonthHeading('2026-11-03T23:00:00Z')).toBe('November 2026');
    // 2026-12-01T03:00Z is still November 30 in Philly.
    expect(eventMonthHeading('2026-12-01T03:00:00Z')).toBe('November 2026');
  });

  it('compact agenda range', () => {
    expect(formatCompactRange('2026-11-03T23:00:00Z', '2026-11-04T02:00:00Z')).toBe('6–9pm');
    expect(formatCompactRange('2026-11-03T14:00:00Z', '2026-11-04T00:00:00Z')).toBe('9am–7pm');
    expect(formatCompactRange('2026-11-03T23:30:00Z', null)).toBe('6:30pm');
    // 6:00–8:30 PM EST: start drops its minutes and meridiem, end keeps both.
    expect(formatCompactRange('2026-11-03T23:00:00Z', '2026-11-04T01:30:00Z')).toBe('6–8:30pm');
    // 11:30 AM–1 PM EST crosses noon, so both ends carry a meridiem.
    expect(formatCompactRange('2026-11-03T16:30:00Z', '2026-11-03T18:00:00Z')).toBe('11:30am–1pm');
  });

  it('agenda day heading in Philly time', () => {
    // 2023-03-31T22:00Z is Friday 6 PM EDT.
    expect(agendaDayHeading('2023-03-31T22:00:00Z')).toEqual({
      key: '2023-03-31',
      weekday: 'Friday',
      date: 'March 31',
    });
    // 03:00Z on Apr 1 is still Friday, March 31 in Philly.
    expect(agendaDayHeading('2023-04-01T03:00:00Z')).toMatchObject({ key: '2023-03-31', weekday: 'Friday' });
  });
});

describe('wall-clock ↔ UTC', () => {
  it('round-trips in EDT', () => {
    const utc = phillyWallClockToUtc('2026-07-07', '18:00');
    expect(utc).toBe('2026-07-07T22:00:00Z');
    expect(utcToPhillyWallClock(utc!)).toEqual({ date: '2026-07-07', time: '18:00' });
  });

  it('round-trips in EST', () => {
    const utc = phillyWallClockToUtc('2026-11-03', '18:00');
    expect(utc).toBe('2026-11-03T23:00:00Z');
    expect(utcToPhillyWallClock(utc!)).toEqual({ date: '2026-11-03', time: '18:00' });
  });

  it('resolves the ambiguous fall-back hour to EDT and the spring gap forward', () => {
    expect(phillyWallClockToUtc('2026-11-01', '01:30')).toBe('2026-11-01T05:30:00Z');
    expect(phillyWallClockToUtc('2026-03-08', '02:30')).toBe('2026-03-08T07:30:00Z');
  });

  it('rejects malformed input', () => {
    expect(phillyWallClockToUtc('', '18:00')).toBeNull();
    expect(phillyWallClockToUtc('2026-11-03', '')).toBeNull();
  });

  it('adds 2h30 across midnight', () => {
    expect(addMinutesToWallClock('2026-11-03', '22:00', 150)).toEqual({ date: '2026-11-04', time: '00:30' });
  });
});

describe('shiftOneMonthInPhilly', () => {
  it('keeps 6 PM when shifting across the November DST change', () => {
    // Oct 6 2026, 6 PM EDT → Nov 6 2026, 6 PM EST
    const shifted = shiftOneMonthInPhilly('2026-10-06T22:00:00Z');
    expect(shifted).toBe('2026-11-06T23:00:00Z');
    expect(utcToPhillyWallClock(shifted)).toEqual({ date: '2026-11-06', time: '18:00' });
  });

  it('keeps 6 PM across the March change and rolls the year', () => {
    expect(shiftOneMonthInPhilly('2026-12-01T23:00:00Z')).toBe('2027-01-01T23:00:00Z');
    expect(shiftOneMonthInPhilly('2027-02-20T23:00:00Z')).toBe('2027-03-20T22:00:00Z');
  });

  it('clamps the day to the target month', () => {
    expect(utcToPhillyWallClock(shiftOneMonthInPhilly('2027-01-31T23:00:00Z')).date).toBe('2027-02-28');
  });
});

describe('googleCalendarUrl', () => {
  it('builds a prefilled template link', () => {
    const url = new URL(
      googleCalendarUrl(
        {
          slug: '2026-11-03-hack-night',
          title: 'Hack Night',
          startsAt: '2026-11-03T23:00:00Z',
          endsAt: '2026-11-04T01:30:00Z',
          description: 'Bring a **laptop**.',
          venueName: 'Indy Hall',
          venueAddress: '709 N 2nd St',
          onlineUrl: null,
        },
        'https://codeforphilly.org',
      ),
    );
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Hack Night');
    expect(url.searchParams.get('dates')).toBe('20261103T230000Z/20261104T013000Z');
    expect(url.searchParams.get('details')).toBe(
      'Bring a laptop.\n\nhttps://codeforphilly.org/events/2026-11-03-hack-night',
    );
    expect(url.searchParams.get('location')).toBe('Indy Hall, 709 N 2nd St');
  });
});
