import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { EventSummary } from '@/lib/api';
import { eventDateBlock, formatEventTimeOnly } from '@/lib/event-time';
import { cn } from '@/lib/utils';

/** Where line per specs/screens/events-index.md. */
export function eventWhereLine(e: Pick<EventSummary, 'venueName' | 'onlineUrl'>): string {
  if (e.venueName) return e.onlineUrl ? `${e.venueName} · Online option` : e.venueName;
  if (e.onlineUrl) return 'Online';
  return 'Location TBA';
}

export function EventDateBlock({ startsAt, className }: { startsAt: string; className?: string }) {
  const { dow, day, mon } = eventDateBlock(startsAt);
  return (
    <div
      className={cn(
        'flex w-14 shrink-0 flex-col items-center justify-center rounded-md border border-border bg-muted/40 py-1.5 text-center leading-tight',
        className,
      )}
      aria-hidden="true"
    >
      <span className="text-[11px] font-medium uppercase text-muted-foreground">{dow}</span>
      <span className="text-xl font-bold">{day}</span>
      <span className="text-[11px] font-medium uppercase text-muted-foreground">{mon}</span>
    </div>
  );
}

interface EventCardProps {
  event: EventSummary;
  /** "full" for the events index; "compact" for the home strip rows. */
  variant?: 'full' | 'compact';
  /** Interactive control (the home strip's inline RSVP) — sits above the stretched link. */
  action?: ReactNode;
  headingLevel?: 'h2' | 'h3';
}

/**
 * One event as a card. The title link is stretched over the whole card so
 * the card is clickable, while an optional `action` button stays its own
 * focus target instead of nesting inside the link.
 */
export function EventCard({ event, variant = 'full', action, headingLevel = 'h3' }: EventCardProps) {
  const Heading = headingLevel;
  const cancelled = event.status === 'cancelled';
  const draft = event.status === 'draft';
  const going = event.viewerRsvp !== null;
  const date = eventDateBlock(event.startsAt);

  return (
    <div
      className={cn(
        'relative flex items-center gap-4 rounded-lg border border-border bg-card transition-shadow hover:shadow-md',
        variant === 'full' ? 'p-4' : 'p-3',
        cancelled && 'opacity-70',
      )}
    >
      <EventDateBlock startsAt={event.startsAt} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Heading className={cn('font-semibold', variant === 'full' ? 'text-lg' : 'text-base', cancelled && 'line-through decoration-1')}>
            <Link
              to={`/events/${event.slug}`}
              className="hover:text-primary after:absolute after:inset-0 after:content-['']"
            >
              {event.title}
            </Link>
          </Heading>
          {cancelled && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">Cancelled</span>
          )}
          {draft && (
            <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-900">Draft</span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {/* The date block is aria-hidden; screen readers get the date here. */}
          <span className="sr-only">{`${date.dow}, ${date.mon} ${date.day} · `}</span>
          {formatEventTimeOnly(event.startsAt, event.endsAt)}
        </p>
        <p className="text-sm text-muted-foreground">{eventWhereLine(event)}</p>
        <p className="text-sm">
          {going && <span className="font-medium text-green-700">You&rsquo;re going ✓ · </span>}
          <span className="text-muted-foreground">{event.rsvpCount} going</span>
        </p>
      </div>
      {action && <div className="relative z-10 shrink-0">{action}</div>}
    </div>
  );
}

/** `webcal://` and `https://` forms of the subscription feed for this host. */
export function calendarFeedUrls(): { webcal: string; https: string } {
  const { host, protocol } = window.location;
  return {
    webcal: `webcal://${host}/api/events/feed.ics`,
    https: `${protocol === 'http:' ? 'http' : 'https'}://${host}/api/events/feed.ics`,
  };
}
