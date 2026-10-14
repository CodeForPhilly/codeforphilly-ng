import { MapPinIcon } from 'lucide-react';
import { MarkdownView } from '@/components/MarkdownView';
import type { EventAgendaItem } from '@/lib/api';
import { agendaDayHeading, formatCompactRange } from '@/lib/event-time';

interface Venue {
  name: string;
  address: string | null;
}

function venueKey(v: Venue | null): string | null {
  return v ? [v.name, v.address].filter(Boolean).join(', ') : null;
}

function itemVenue(item: EventAgendaItem): Venue | null {
  return item.venueName ? { name: item.venueName, address: item.venueAddress } : null;
}

export interface ScheduleDay {
  key: string;
  weekday: string;
  date: string;
  items: Array<{ item: EventAgendaItem; venue: Venue | null }>;
}

/**
 * Group an agenda by Philly day and decide which items show a venue line.
 *
 * An item without a venue override happens at the event's venue. A venue
 * line renders only when an item's effective venue differs from the one
 * before it that day; each day starts from the event's own venue, which the
 * page header already shows (behaviors/events.md#agenda).
 */
export function groupSchedule(agenda: readonly EventAgendaItem[], eventVenue: Venue | null): ScheduleDay[] {
  const days: ScheduleDay[] = [];
  let prevKey: string | null = null;
  for (const item of agenda) {
    const h = agendaDayHeading(item.startsAt);
    let day = days[days.length - 1];
    if (!day || day.key !== h.key) {
      day = { ...h, items: [] };
      days.push(day);
      prevKey = venueKey(eventVenue);
    }
    const effective = itemVenue(item) ?? eventVenue;
    const key = venueKey(effective);
    day.items.push({ item, venue: key !== null && key !== prevKey ? effective : null });
    prevKey = key;
  }
  return days;
}

interface ScheduleBlockProps {
  agenda: readonly EventAgendaItem[];
  /** The event's own venue; agenda items without an override happen there. */
  eventVenue?: Venue | null;
  id?: string;
  className?: string;
}

/** The day-grouped Schedule block on event detail (screens/event-detail.md). */
export function ScheduleBlock({ agenda, eventVenue = null, id, className }: ScheduleBlockProps) {
  const days = groupSchedule(agenda, eventVenue);
  return (
    <section id={id} className={className}>
      <h2 className="mb-3 text-xl font-semibold">Schedule</h2>
      <div className="space-y-5">
        {days.map((d) => (
          <div key={d.key}>
            <h3 className="mb-2 text-sm">
              <strong>{d.weekday},</strong> {d.date}
            </h3>
            <ul className="space-y-3">
              {d.items.map(({ item, venue }, i) => (
                <li key={`${item.startsAt}-${i}`} className="text-sm">
                  <div className="flex gap-3">
                    {/* Wide enough for the longest range ("11:30am–12:30pm") on one line. */}
                    <span className="w-28 shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
                      {formatCompactRange(item.startsAt, item.endsAt)}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium">{item.title}</p>
                      {venue && (
                        <a
                          href={`https://maps.google.com/?q=${encodeURIComponent(venueKey(venue)!)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <MapPinIcon className="size-3" aria-hidden="true" />
                          {venue.name}
                        </a>
                      )}
                      {item.descriptionHtml && <MarkdownView html={item.descriptionHtml} className="text-sm" />}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
