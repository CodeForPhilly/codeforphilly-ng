import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EventCard, calendarFeedUrls } from '@/components/EventCard';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError, type EventSummary, type PaginatedEnvelope } from '@/lib/api';

const QUERY_KEY = ['events', { when: 'upcoming', perPage: 3 }] as const;

/**
 * Home page "Upcoming Events" strip (specs/screens/home.md §1b). Hidden
 * entirely when nothing is upcoming — an empty box would advertise that
 * nothing is happening.
 */
export function UpcomingEventsStrip() {
  const { person } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.events.list({ when: 'upcoming', perPage: 3 }),
  });

  const events = q.data?.data ?? [];
  if (events.length === 0) return null;

  const rsvp = async (event: EventSummary) => {
    setBusy(true);
    try {
      const res = await api.events.rsvp(event.slug, {});
      const { rsvp: r, rsvpCount } = res.data;
      queryClient.setQueryData<PaginatedEnvelope<EventSummary>>(QUERY_KEY, (old) =>
        old
          ? {
              ...old,
              data: old.data.map((e) =>
                e.slug === event.slug
                  ? { ...e, rsvpCount, viewerRsvp: { plan: r.plan, project: r.project, createdAt: r.createdAt } }
                  : e,
              ),
            }
          : old,
      );
      void queryClient.invalidateQueries({ queryKey: ['event', event.slug] });
      toast.success(
        res.data.confirmationDelivered === false
          ? "You're going — we couldn't send the calendar email."
          : "You're going — check your email for a calendar invite.",
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save your RSVP.");
      if (err instanceof ApiError && err.code === 'rsvp_closed') void q.refetch();
    } finally {
      setBusy(false);
    }
  };

  const actionFor = (event: EventSummary) => {
    if (event.status !== 'scheduled' || event.viewerRsvp) return undefined;
    if (!person) {
      return (
        <Button asChild size="sm">
          <Link to={`/login?return=${encodeURIComponent(`/events/${event.slug}`)}`}>Sign in to RSVP</Link>
        </Button>
      );
    }
    return (
      <Button size="sm" disabled={busy} onClick={() => void rsvp(event)}>
        RSVP
      </Button>
    );
  };

  return (
    <section className="border-b border-border bg-muted/30">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-2xl font-bold">Upcoming Events</h2>
          <div className="flex gap-4 text-sm">
            <a href={calendarFeedUrls().webcal} className="text-primary hover:underline">
              Subscribe
            </a>
            <Link to="/events" className="text-primary hover:underline">
              See all events →
            </Link>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {events.map((e, i) => (
            <EventCard key={e.id} event={e} variant="compact" action={i === 0 ? actionFor(e) : undefined} />
          ))}
        </div>
      </div>
    </section>
  );
}
