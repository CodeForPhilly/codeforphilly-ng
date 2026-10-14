/**
 * Event time helpers. Per specs/behaviors/events.md#time, every event time is
 * shown in America/New_York with its zone abbreviation, regardless of the
 * viewer's browser zone. The staff form takes Philly wall-clock values and
 * converts them to UTC before calling the API.
 *
 * Everything here goes through Intl.DateTimeFormat with an explicit timeZone —
 * no Date#getHours() etc., which would leak the browser's zone.
 */

export const EVENT_TIME_ZONE = 'America/New_York';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface PhillyParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  /** 0–23 */
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
  /** "EST" | "EDT" */
  zone: string;
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EVENT_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
  weekday: 'short',
  timeZoneName: 'short',
});

/** Break an instant into its America/New_York wall-clock components. */
export function phillyParts(input: string | Date | number): PhillyParts {
  const date = input instanceof Date ? input : new Date(input);
  const out: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out['year']),
    month: Number(out['month']),
    day: Number(out['day']),
    hour: Number(out['hour']) % 24,
    minute: Number(out['minute']),
    weekday: WEEKDAYS_SHORT.indexOf(out['weekday'] ?? 'Sun'),
    zone: out['timeZoneName'] ?? '',
  };
}

function sameDay(a: PhillyParts, b: PhillyParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function clock(p: PhillyParts): { text: string; meridiem: 'AM' | 'PM' } {
  const h12 = p.hour % 12 || 12;
  return { text: `${h12}:${pad2(p.minute)}`, meridiem: p.hour < 12 ? 'AM' : 'PM' };
}

type Style = 'short' | 'long';

function dateLabel(p: PhillyParts, style: Style, currentYear: number): string {
  const dow = style === 'long' ? WEEKDAYS_LONG[p.weekday] : WEEKDAYS_SHORT[p.weekday];
  const mon = style === 'long' ? MONTHS_LONG[p.month - 1] : MONTHS_SHORT[p.month - 1];
  const year = p.year === currentYear ? '' : `, ${p.year}`;
  return `${dow}, ${mon} ${p.day}${year}`;
}

function sameDayRange(s: PhillyParts, e: PhillyParts): string {
  const a = clock(s);
  const b = clock(e);
  // "6:00–8:30 PM" when both share a meridiem; "11:00 AM–1:00 PM" otherwise.
  const left = a.meridiem === b.meridiem ? a.text : `${a.text} ${a.meridiem}`;
  return `${left}–${b.text} ${b.meridiem} ${e.zone}`;
}

function multiDayRange(s: PhillyParts, e: PhillyParts, style: Style, currentYear: number): string {
  const a = clock(s);
  const b = clock(e);
  // One trailing abbreviation per the spec; a range that crosses a DST change
  // labels the start too so neither end is ambiguous.
  const startZone = s.zone !== e.zone ? ` ${s.zone}` : '';
  return (
    `${dateLabel(s, style, currentYear)}, ${a.text} ${a.meridiem}${startZone} – ` +
    `${dateLabel(e, style, currentYear)}, ${b.text} ${b.meridiem} ${e.zone}`
  );
}

export interface FormatEventTimeOptions {
  /** "short" → `Tue, Nov 3`; "long" → `Tuesday, November 3` (detail page). */
  style?: Style;
  now?: Date;
}

/**
 * Full when-line for an event:
 *   same day  → `Tue, Nov 3 · 6:00–8:30 PM EST`
 *   multi-day → `Fri, Mar 31, 6:00 PM – Wed, May 10, 9:00 PM EDT`
 * The year is appended only when the date is not in the current year.
 */
export function formatEventTime(startsAt: string, endsAt: string, opts: FormatEventTimeOptions = {}): string {
  const style = opts.style ?? 'short';
  const currentYear = phillyParts(opts.now ?? new Date()).year;
  const s = phillyParts(startsAt);
  const e = phillyParts(endsAt);
  if (sameDay(s, e)) return `${dateLabel(s, style, currentYear)} · ${sameDayRange(s, e)}`;
  return multiDayRange(s, e, style, currentYear);
}

/**
 * Time line for an event card, where the date block already carries the day:
 * `6:00–8:30 PM EST` for same-day events, the full multi-day range otherwise.
 */
export function formatEventTimeOnly(startsAt: string, endsAt: string, now: Date = new Date()): string {
  const s = phillyParts(startsAt);
  const e = phillyParts(endsAt);
  if (sameDay(s, e)) return sameDayRange(s, e);
  return multiDayRange(s, e, 'short', phillyParts(now).year);
}

/** Date-block pieces for an event card: `{ dow: 'Tue', day: '3', mon: 'Nov' }`. */
export function eventDateBlock(iso: string): { dow: string; day: string; mon: string } {
  const p = phillyParts(iso);
  return { dow: WEEKDAYS_SHORT[p.weekday]!, day: String(p.day), mon: MONTHS_SHORT[p.month - 1]! };
}

/** Month heading for grouping event lists: `November 2026`. */
export function eventMonthHeading(iso: string): string {
  const p = phillyParts(iso);
  return `${MONTHS_LONG[p.month - 1]} ${p.year}`;
}

/** Agenda day heading pieces: `{ weekday: 'Friday', date: 'March 31' }`. */
export function agendaDayHeading(iso: string): { key: string; weekday: string; date: string } {
  const p = phillyParts(iso);
  return {
    key: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    weekday: WEEKDAYS_LONG[p.weekday]!,
    date: `${MONTHS_LONG[p.month - 1]} ${p.day}`,
  };
}

function compactClock(p: PhillyParts, withMeridiem: boolean): string {
  const h12 = p.hour % 12 || 12;
  const base = p.minute === 0 ? `${h12}` : `${h12}:${pad2(p.minute)}`;
  return withMeridiem ? `${base}${p.hour < 12 ? 'am' : 'pm'}` : base;
}

/** Compact agenda range: `6–9pm`, `9am–7pm`, `6:30pm`. */
export function formatCompactRange(startsAt: string, endsAt: string | null): string {
  const s = phillyParts(startsAt);
  if (!endsAt) return compactClock(s, true);
  const e = phillyParts(endsAt);
  const shareMeridiem = s.hour < 12 === e.hour < 12;
  return `${compactClock(s, !shareMeridiem)}–${compactClock(e, true)}`;
}

/** True once the event has ended (`endsAt ≤ now`). */
export function isPastEvent(endsAt: string, now: Date = new Date()): boolean {
  return new Date(endsAt).getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Wall-clock ↔ UTC (staff form)
// ---------------------------------------------------------------------------

/** Philly offset from UTC at `instantMs`, in ms (e.g. -5h for EST). */
function phillyOffsetMs(instantMs: number): number {
  const p = phillyParts(instantMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const floored = Math.floor(instantMs / 60_000) * 60_000;
  return asUtc - floored;
}

function toIsoZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Convert a Philadelphia wall-clock date (`YYYY-MM-DD`) and time (`HH:MM`)
 * to a UTC ISO string. Returns null when either input is malformed.
 *
 * A nonexistent local time (inside the spring-forward gap) resolves to the
 * instant one hour later; an ambiguous one (fall-back) resolves to the first
 * (EDT) occurrence.
 */
export function phillyWallClockToUtc(date: string, time: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!dm || !tm) return null;
  const guess = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  if (Number.isNaN(guess)) return null;
  // Try the offset in effect a few hours either side of the guess; the first
  // candidate that round-trips to the requested wall-clock wins. Ordering
  // the earlier offset first picks the EDT reading of an ambiguous hour.
  const offsets = [phillyOffsetMs(guess - 6 * 3_600_000), phillyOffsetMs(guess + 6 * 3_600_000)];
  for (const off of offsets) {
    const candidate = guess - off;
    if (phillyOffsetMs(candidate) === off) return toIsoZ(candidate);
  }
  // Spring-forward gap: no reading round-trips; use the pre-transition offset.
  return toIsoZ(guess - offsets[0]!);
}

/** Inverse of phillyWallClockToUtc: `{ date: 'YYYY-MM-DD', time: 'HH:MM' }`. */
export function utcToPhillyWallClock(iso: string): { date: string; time: string } {
  const p = phillyParts(iso);
  return { date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`, time: `${pad2(p.hour)}:${pad2(p.minute)}` };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Shift an instant forward one calendar month in Philadelphia: same
 * day-of-month (clamped to the target month's length, so Jan 31 → Feb 28)
 * and the same wall-clock time, DST-safe.
 */
export function shiftOneMonthInPhilly(iso: string): string {
  const p = phillyParts(iso);
  const year = p.month === 12 ? p.year + 1 : p.year;
  const month = p.month === 12 ? 1 : p.month + 1;
  const day = Math.min(p.day, daysInMonth(year, month));
  return phillyWallClockToUtc(`${year}-${pad2(month)}-${pad2(day)}`, `${pad2(p.hour)}:${pad2(p.minute)}`)!;
}

/** Add minutes to a Philly wall-clock pair; returns the new wall-clock pair. */
export function addMinutesToWallClock(date: string, time: string, minutes: number): { date: string; time: string } | null {
  const utc = phillyWallClockToUtc(date, time);
  if (!utc) return null;
  return utcToPhillyWallClock(toIsoZ(new Date(utc).getTime() + minutes * 60_000));
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

function gcalStamp(iso: string): string {
  return toIsoZ(new Date(iso).getTime()).replace(/[-:]/g, '');
}

/** Crude markdown → plain text for calendar descriptions. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export interface CalendarLinkEvent {
  slug: string;
  title: string;
  startsAt: string;
  endsAt: string;
  description?: string | null;
  venueName: string | null;
  venueAddress: string | null;
  onlineUrl: string | null;
}

/** The iCal LOCATION string: `venueName, venueAddress`, else `onlineUrl`. */
export function eventLocationString(e: Pick<CalendarLinkEvent, 'venueName' | 'venueAddress' | 'onlineUrl'>): string {
  if (e.venueName) return e.venueAddress ? `${e.venueName}, ${e.venueAddress}` : e.venueName;
  return e.onlineUrl ?? '';
}

/**
 * Prefilled `calendar.google.com/calendar/render?action=TEMPLATE` link per
 * specs/behaviors/events.md#calendar-files.
 */
export function googleCalendarUrl(event: CalendarLinkEvent, origin: string): string {
  const canonical = `${origin}/events/${event.slug}`;
  const body = event.description ? stripMarkdown(event.description) : '';
  const details = body ? `${body}\n\n${canonical}` : canonical;
  const usp = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${gcalStamp(event.startsAt)}/${gcalStamp(event.endsAt)}`,
    details,
  });
  const location = eventLocationString(event);
  if (location) usp.set('location', location);
  return `https://calendar.google.com/calendar/render?${usp.toString()}`;
}
