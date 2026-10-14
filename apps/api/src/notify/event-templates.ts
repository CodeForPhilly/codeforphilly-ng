/**
 * Email templates for event notifications — specs/behaviors/events.md.
 *
 * Same conventions as templates.ts: plain-text + inline-styled HTML, every
 * user-supplied field HTML-escaped, absolute URLs on the configured host.
 * The `.ics` rides along as an attachment so "add to calendar" works from
 * any mail client; the Google link is the one-click alternative.
 */
import type {
  EventCancelledNotification,
  EventEmailFacts,
  EventReminderNotification,
  EventRsvpNotification,
  EventUpdatedNotification,
} from './index.js';
import type { EmailAttachment } from './transport.js';

export interface EventTemplate {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly attachments: ReadonlyArray<EmailAttachment>;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function icsAttachment(slug: string, ics: string): EmailAttachment {
  return {
    name: `${slug}.ics`,
    contentType: 'text/calendar; charset=utf-8',
    content: Buffer.from(ics, 'utf8').toString('base64'),
  };
}

function mapsUrl(e: EventEmailFacts): string {
  return `https://maps.google.com/?q=${encodeURIComponent([e.venueName, e.venueAddress].filter(Boolean).join(', '))}`;
}

/** The when/where block shared by every event email (text form). */
function whereText(e: EventEmailFacts): string[] {
  const lines: string[] = [];
  if (e.venueName) {
    lines.push(`Where: ${e.venueName}${e.venueAddress ? `, ${e.venueAddress}` : ''}`);
    if (e.venueAddress) lines.push(`       ${mapsUrl(e)}`);
  }
  if (e.onlineUrl) lines.push(`${e.venueName ? 'Online option' : 'Where'}: ${e.onlineUrl}`);
  if (!e.venueName && !e.onlineUrl) lines.push('Where: to be announced');
  return lines;
}

function whereHtml(e: EventEmailFacts): string {
  const parts: string[] = [];
  if (e.venueName) {
    const addr = e.venueAddress
      ? ` · <a href="${mapsUrl(e)}">${escapeHtml(e.venueAddress)}</a>`
      : '';
    parts.push(`<strong>${escapeHtml(e.venueName)}</strong>${addr}`);
  }
  if (e.onlineUrl) parts.push(`<a href="${escapeHtml(e.onlineUrl)}">Join online</a>`);
  if (parts.length === 0) parts.push('Location to be announced');
  return parts.join('<br>');
}

function shell(body: string, footer: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 0 auto; padding: 1rem; color: #111;">
${body}
  <hr style="border: none; border-top: 1px solid #eee; margin: 2rem 0;">
  <p style="color: #666; font-size: 0.875rem;">${footer}</p>
</body>
</html>`;
}

function button(href: string, label: string, color = '#16a34a'): string {
  return `<a href="${href}" style="display: inline-block; padding: 0.5rem 1rem; background: ${color}; color: #fff; text-decoration: none; border-radius: 4px;">${label}</a>`;
}

export function renderEventRsvpEmail(n: EventRsvpNotification, siteHost: string): EventTemplate {
  const e = n.event;
  void siteHost;
  const subject = `You're going: ${e.title} — ${e.when}`;
  const text = [
    `Hey ${n.fullName} — you're on the list for ${e.title}.`,
    '',
    `When:  ${e.when}`,
    ...whereText(e),
    '',
    `Add it to your calendar: the .ics is attached, or use Google Calendar:`,
    `  ${n.googleCalendarUrl}`,
    '',
    `Event page: ${e.url}`,
    `Can't make it? Update your RSVP there.`,
    '',
    `— Code for Philly`,
  ].join('\n');

  const html = shell(
    `  <p>Hey ${escapeHtml(n.fullName)} — you're on the list for <a href="${e.url}"><strong>${escapeHtml(e.title)}</strong></a>.</p>
  <p><strong>When:</strong> ${escapeHtml(e.when)}<br><strong>Where:</strong> ${whereHtml(e)}</p>
  <p>${button(n.googleCalendarUrl, 'Add to Google Calendar')} &nbsp; ${button(e.url, 'View event', '#262626')}</p>
  <p style="color: #666; font-size: 0.875rem;">The calendar file (.ics) is attached for every other calendar app. Can't make it? Update your RSVP on the event page.</p>`,
    `You're receiving this because you RSVP'd to an event on Code for Philly.`,
  );

  return { subject, text, html, attachments: [icsAttachment(e.slug, n.ics)] };
}

const FIELD_LABELS: Record<string, string> = {
  startsAt: 'Start',
  endsAt: 'End',
  venueName: 'Venue',
  venueAddress: 'Address',
  onlineUrl: 'Online link',
};

export function renderEventUpdatedEmail(n: EventUpdatedNotification, siteHost: string): EventTemplate {
  const e = n.event;
  void siteHost;
  const subject = `Updated: ${e.title} — ${e.when}`;
  const changeLines = n.changes.map(
    (c) => `  - ${FIELD_LABELS[c.field] ?? c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`,
  );
  const text = [
    `Hey ${n.fullName} — ${e.title} changed and you're RSVP'd, so here's the new plan.`,
    '',
    `What changed:`,
    ...changeLines,
    '',
    `Now:   ${e.when}`,
    ...whereText(e),
    '',
    `The attached .ics replaces the earlier calendar entry.`,
    `Event page: ${e.url}`,
    `Can't make it anymore? Update your RSVP there.`,
    '',
    `— Code for Philly`,
  ].join('\n');

  const changesHtml = n.changes
    .map(
      (c) =>
        `<li><strong>${escapeHtml(FIELD_LABELS[c.field] ?? c.field)}:</strong> ${escapeHtml(c.from ?? '—')} → ${escapeHtml(c.to ?? '—')}</li>`,
    )
    .join('');
  const html = shell(
    `  <p>Hey ${escapeHtml(n.fullName)} — <a href="${e.url}"><strong>${escapeHtml(e.title)}</strong></a> changed and you're RSVP'd, so here's the new plan.</p>
  <ul>${changesHtml}</ul>
  <p><strong>Now:</strong> ${escapeHtml(e.when)}<br><strong>Where:</strong> ${whereHtml(e)}</p>
  <p>${button(e.url, 'View event', '#262626')}</p>
  <p style="color: #666; font-size: 0.875rem;">The attached .ics replaces the earlier calendar entry. Can't make it anymore? Update your RSVP on the event page.</p>`,
    `You're receiving this because you RSVP'd to an event on Code for Philly.`,
  );

  return { subject, text, html, attachments: [icsAttachment(e.slug, n.ics)] };
}

export function renderEventReminderEmail(n: EventReminderNotification, siteHost: string): EventTemplate {
  const e = n.event;
  void siteHost;
  const lead = n.kind === 'week' ? 'Next week' : 'Tomorrow';
  const subject = `${lead}: ${e.title} — ${e.when}`;
  const text = [
    `Hey ${n.fullName} — ${lead.toLowerCase()} is ${e.title}, and you're on the list.`,
    '',
    `When:  ${e.when}`,
    ...whereText(e),
    '',
    n.planLine ? `${n.planLine}\n` : '',
    `Event page: ${e.url}`,
    `Can't make it? Update your RSVP there.`,
    '',
    `— Code for Philly`,
  ]
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
    .join('\n');

  const html = shell(
    `  <p>Hey ${escapeHtml(n.fullName)} — ${lead.toLowerCase()} is <a href="${e.url}"><strong>${escapeHtml(e.title)}</strong></a>, and you're on the list.</p>
  <p><strong>When:</strong> ${escapeHtml(e.when)}<br><strong>Where:</strong> ${whereHtml(e)}</p>
${n.planLine ? `  <p>${escapeHtml(n.planLine)}</p>` : ''}
  <p>${button(e.url, 'View event', '#262626')}</p>
  <p style="color: #666; font-size: 0.875rem;">Can't make it? Update your RSVP on the event page.</p>`,
    `You're receiving this because you RSVP'd to an event on Code for Philly.`,
  );

  return { subject, text, html, attachments: [] };
}

export function renderEventCancelledEmail(n: EventCancelledNotification, siteHost: string): EventTemplate {
  const e = n.event;
  void siteHost;
  const subject = `Cancelled: ${e.title} — ${e.when}`;
  const text = [
    `Hey ${n.fullName} — ${e.title} (${e.when}) has been cancelled.`,
    '',
    n.note ? `${n.note}\n` : '',
    `The attached .ics marks the calendar entry cancelled.`,
    `Event page: ${e.url}`,
    '',
    `— Code for Philly`,
  ]
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
    .join('\n');

  const html = shell(
    `  <p>Hey ${escapeHtml(n.fullName)} — <a href="${e.url}"><strong>${escapeHtml(e.title)}</strong></a> (${escapeHtml(e.when)}) has been <strong>cancelled</strong>.</p>
${n.note ? `  <blockquote style="border-left: 3px solid #ccc; padding: 0.25rem 1rem; margin: 1rem 0; color: #333; white-space: pre-wrap;">${escapeHtml(n.note)}</blockquote>` : ''}
  <p style="color: #666; font-size: 0.875rem;">The attached .ics marks the calendar entry cancelled.</p>`,
    `You're receiving this because you RSVP'd to an event on Code for Philly.`,
  );

  return { subject, text, html, attachments: [icsAttachment(e.slug, n.ics)] };
}
