/**
 * Event time formatting — server side.
 *
 * Events are always rendered in `America/New_York` with the zone
 * abbreviation, regardless of where the reader is
 * (specs/behaviors/events.md#time). The SPA has its own copy of these
 * rules for screens; this module serves emails, the `.ics` description,
 * and the default slug.
 */

export const EVENT_TIME_ZONE = 'America/New_York';

interface Parts {
  readonly weekday: string;
  readonly weekdayLong: string;
  readonly month: string;
  readonly day: string;
  readonly year: string;
  readonly hour: string;
  readonly minute: string;
  readonly dayPeriod: string;
  readonly zone: string;
}

function partsOf(iso: string): Parts {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: EVENT_TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) map[p.type] = p.value;
  const weekdayLong = new Intl.DateTimeFormat('en-US', { timeZone: EVENT_TIME_ZONE, weekday: 'long' }).format(d);
  return {
    weekday: map['weekday'] ?? '',
    weekdayLong,
    month: map['month'] ?? '',
    day: map['day'] ?? '',
    year: map['year'] ?? '',
    hour: map['hour'] ?? '',
    minute: map['minute'] ?? '',
    dayPeriod: (map['dayPeriod'] ?? '').toUpperCase(),
    zone: map['timeZoneName'] ?? '',
  };
}

/** `YYYY-MM-DD` of an instant in Philadelphia — the default slug prefix. */
export function nyDateString(iso: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA yields YYYY-MM-DD
  return fmt.format(new Date(iso));
}

function sameNyDay(a: string, b: string): boolean {
  return nyDateString(a) === nyDateString(b);
}

function clock(p: Parts, withPeriod: boolean): string {
  return `${p.hour}:${p.minute}${withPeriod ? ` ${p.dayPeriod}` : ''}`;
}

function datePart(p: Parts, longWeekday: boolean, withYear: boolean): string {
  const wd = longWeekday ? p.weekdayLong : p.weekday;
  return `${wd}, ${p.month} ${p.day}${withYear ? `, ${p.year}` : ''}`;
}

/**
 * The spec's display format:
 *   same day:  `Tue, Nov 3 · 6:00–8:30 PM EST`   (`10:00 AM–1:00 PM EST` across noon)
 *   multi-day: `Fri, Mar 31, 6:00 PM – Wed, May 10, 9:00 PM EDT`
 * The year is appended only when the event isn't in the current calendar
 * year (Philadelphia time). `longWeekday` spells the weekday out for the
 * detail/email heading form (`Tuesday, November 3 · …` is the SPA's job;
 * emails use the short month to keep subject lines tight).
 */
export function formatEventWhen(
  startsAt: string,
  endsAt: string,
  opts: { longWeekday?: boolean; now?: Date } = {},
): string {
  const now = opts.now ?? new Date();
  const s = partsOf(startsAt);
  const e = partsOf(endsAt);
  const currentYear = partsOf(now.toISOString()).year;
  const withYear = s.year !== currentYear;
  const long = opts.longWeekday ?? false;

  if (sameNyDay(startsAt, endsAt)) {
    const samePeriod = s.dayPeriod === e.dayPeriod;
    return `${datePart(s, long, withYear)} · ${clock(s, !samePeriod)}–${clock(e, true)} ${e.zone}`;
  }
  return `${datePart(s, long, withYear)}, ${clock(s, true)} – ${datePart(e, long, withYear)}, ${clock(e, true)} ${e.zone}`;
}

/** A single instant: `Tue, Nov 3 · 6:00 PM EST` — used when an email names an old → new time. */
export function formatEventInstant(iso: string, now: Date = new Date()): string {
  const p = partsOf(iso);
  const withYear = p.year !== partsOf(now.toISOString()).year;
  return `${datePart(p, false, withYear)} · ${clock(p, true)} ${p.zone}`;
}

/** `Friday, March 31` — day heading used by schedule renderings. */
export function formatEventDayHeading(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EVENT_TIME_ZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

/** Compact range for agenda lines: `6–9pm`, `9am–7pm`, `6–8:30pm`. */
export function formatCompactRange(startsAt: string, endsAt: string | null | undefined): string {
  const s = partsOf(startsAt);
  const compact = (p: Parts, withPeriod: boolean): string => {
    const min = p.minute === '00' ? '' : `:${p.minute}`;
    return `${p.hour}${min}${withPeriod ? p.dayPeriod.toLowerCase() : ''}`;
  };
  if (!endsAt) return compact(s, true);
  const e = partsOf(endsAt);
  const samePeriod = s.dayPeriod === e.dayPeriod;
  return `${compact(s, !samePeriod)}–${compact(e, true)}`;
}
