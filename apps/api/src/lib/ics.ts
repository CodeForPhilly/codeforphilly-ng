/**
 * iCalendar rendering for events — specs/behaviors/events.md#calendar-files.
 *
 * Pure functions: an Event (plus the site host for absolute URLs) in, RFC
 * 5545 text out. Three consumers: the per-event download, the subscription
 * feed, and the `.ics` attachment on RSVP / update / cancellation emails.
 * All three are `METHOD:PUBLISH`; the stable `UID` + increasing `SEQUENCE`
 * is what lets a calendar client replace its copy in place.
 */
import type { Event, EventAgendaItem } from '@cfp/shared/schemas';

import { formatCompactRange, formatEventDayHeading } from './event-time.js';

const PRODID = '-//Code for Philly//codeforphilly.org//EN';
const CRLF = '\r\n';

/** Escape a TEXT value per RFC 5545 §3.3.11. */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold lines longer than 75 octets per RFC 5545 §3.1. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const limit = first ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    // Don't split a UTF-8 sequence: back up to a byte that starts a character.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    out.push((first ? '' : ' ') + bytes.subarray(start, end).toString('utf8'));
    start = end;
    first = false;
  }
  return out.join(CRLF);
}

/** `20261103T230000Z` */
export function icsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function eventUrl(siteHost: string, slug: string): string {
  return `https://${siteHost}/events/${encodeURIComponent(slug)}`;
}

/** The `LOCATION` string: venue + address, else the online URL, else null. */
export function icsLocation(event: Pick<Event, 'venueName' | 'venueAddress' | 'onlineUrl'>): string | null {
  if (event.venueName) {
    return event.venueAddress ? `${event.venueName}, ${event.venueAddress}` : event.venueName;
  }
  return event.onlineUrl ?? null;
}

/**
 * Markdown → plain text, good enough for a calendar description: drop
 * headings/emphasis markers, turn links into "text (url)", collapse blank
 * runs. Not a parser; the body is prose, not code.
 */
export function markdownToPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain-text schedule block for agenda events — appended to DESCRIPTION. */
export function agendaPlainText(agenda: readonly EventAgendaItem[]): string {
  if (agenda.length === 0) return '';
  const lines: string[] = ['Schedule'];
  let lastDay = '';
  for (const item of agenda) {
    const day = formatEventDayHeading(item.startsAt);
    if (day !== lastDay) {
      lines.push('', day);
      lastDay = day;
    }
    const where = item.venueName ? ` @ ${item.venueName}` : '';
    lines.push(`${formatCompactRange(item.startsAt, item.endsAt)} — ${item.title}${where}`);
  }
  return lines.join('\n');
}

/** DESCRIPTION text: description (markdown stripped), schedule, canonical URL. */
export function eventPlainText(event: Event, siteHost: string): string {
  const blocks: string[] = [];
  if (event.description) blocks.push(markdownToPlainText(event.description));
  const schedule = agendaPlainText(event.agenda ?? []);
  if (schedule) blocks.push(schedule);
  blocks.push(eventUrl(siteHost, event.slug));
  return blocks.join('\n\n');
}

/** One VEVENT block (lines, unfolded). */
export function vevent(event: Event, siteHost: string): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${event.id}@codeforphilly.org`,
    `SEQUENCE:${event.icsSequence ?? 0}`,
    `DTSTAMP:${icsUtc(event.updatedAt)}`,
    `DTSTART:${icsUtc(event.startsAt)}`,
    `DTEND:${icsUtc(event.endsAt)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${escapeText(eventPlainText(event, siteHost))}`,
  ];
  const location = icsLocation(event);
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  lines.push(`URL:${eventUrl(siteHost, event.slug)}`);
  lines.push(`STATUS:${event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push('END:VEVENT');
  return lines;
}

function calendar(body: string[], extraHeaders: string[] = []): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...extraHeaders,
    ...body,
    'END:VCALENDAR',
  ];
  return lines.map(fold).join(CRLF) + CRLF;
}

/** A single-event `.ics` (download + email attachment). */
export function buildEventIcs(event: Event, siteHost: string): string {
  return calendar(vevent(event, siteHost));
}

/** The subscription feed: many events, named calendar. */
export function buildFeedIcs(events: readonly Event[], siteHost: string): string {
  const body: string[] = [];
  for (const e of events) body.push(...vevent(e, siteHost));
  return calendar(body, [
    'X-WR-CALNAME:Code for Philly',
    'X-WR-TIMEZONE:America/New_York',
  ]);
}

/** Prefilled Google Calendar "add event" link — a convenience, not a feed. */
export function googleCalendarUrl(event: Event, siteHost: string): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${icsUtc(event.startsAt)}/${icsUtc(event.endsAt)}`,
    details: eventPlainText(event, siteHost),
  });
  const location = icsLocation(event);
  if (location) params.set('location', location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
