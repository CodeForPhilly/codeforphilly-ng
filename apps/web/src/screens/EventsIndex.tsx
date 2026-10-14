import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { EventCard, calendarFeedUrls } from '@/components/EventCard';
import { useAuth } from '@/hooks/useAuth';
import { api, type EventSummary } from '@/lib/api';
import { copyWithToast } from '@/lib/clipboard';
import { eventMonthHeading } from '@/lib/event-time';
import { cn } from '@/lib/utils';

const PAST_PER_PAGE = 30;

/** Group events under month headings, preserving API order. */
function groupByMonth(events: EventSummary[]): Array<{ heading: string; events: EventSummary[] }> {
  const groups: Array<{ heading: string; events: EventSummary[] }> = [];
  for (const e of events) {
    const heading = eventMonthHeading(e.startsAt);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.events.push(e);
    else groups.push({ heading, events: [e] });
  }
  return groups;
}

function SubscribeControl() {
  const urls = calendarFeedUrls();
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <a href={urls.webcal} className="text-primary hover:underline">
        Subscribe to calendar
      </a>
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground underline"
        onClick={() => copyWithToast(urls.https, 'Calendar feed URL copied', "Couldn't copy the feed URL")}
      >
        Copy feed URL
      </button>
    </span>
  );
}

function EventList({ events }: { events: EventSummary[] }) {
  return (
    <div className="space-y-8">
      {groupByMonth(events).map((g) => (
        <section key={g.heading}>
          <h2 className="mb-3 text-lg font-semibold text-muted-foreground">{g.heading}</h2>
          <div className="space-y-3">
            {g.events.map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function UpcomingList({ isStaff }: { isStaff: boolean }) {
  const q = useQuery({
    queryKey: ['events', { when: 'upcoming', perPage: 50 }],
    queryFn: () => api.events.list({ when: 'upcoming', perPage: 50 }),
  });

  if (q.isLoading) return <p className="py-8 text-muted-foreground">Loading events…</p>;
  if (q.isError) return <p className="py-8 text-destructive">Failed to load events.</p>;

  const events = q.data?.data ?? [];
  if (events.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-muted-foreground">
          Nothing on the calendar yet.{' '}
          <Link to="/chat" className="text-primary hover:underline">
            Join the Slack
          </Link>{' '}
          and watch #announcements — or check back soon.
        </p>
        {isStaff && (
          <Button asChild className="mt-4">
            <Link to="/events/new">New event</Link>
          </Button>
        )}
      </div>
    );
  }
  return <EventList events={events} />;
}

function PastList() {
  const [params, setParams] = useSearchParams();
  // ?page=N deep-links to a starting page; "Load more" appends from there.
  const [startPage] = useState(() => Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1));

  const q = useInfiniteQuery({
    queryKey: ['events', { when: 'past', perPage: PAST_PER_PAGE, startPage }],
    queryFn: ({ pageParam }) => api.events.list({ when: 'past', page: pageParam, perPage: PAST_PER_PAGE }),
    initialPageParam: startPage,
    getNextPageParam: (last) =>
      last.metadata.page < last.metadata.totalPages ? last.metadata.page + 1 : undefined,
  });

  if (q.isLoading) return <p className="py-8 text-muted-foreground">Loading events…</p>;
  if (q.isError) return <p className="py-8 text-destructive">Failed to load events.</p>;

  const events = (q.data?.pages ?? []).flatMap((p) => p.data);
  if (events.length === 0) {
    return <p className="py-12 text-center text-muted-foreground">No past events yet.</p>;
  }

  const loadMore = async () => {
    const res = await q.fetchNextPage();
    const pages = res.data?.pages ?? [];
    const lastPage = pages[pages.length - 1]?.metadata.page;
    if (lastPage) {
      const next = new URLSearchParams(params);
      next.set('page', String(lastPage));
      setParams(next, { replace: true });
    }
  };

  return (
    <>
      <EventList events={events} />
      {q.hasNextPage && (
        <div className="mt-8 text-center">
          <Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void loadMore()}>
            {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </>
  );
}

export function EventsIndex() {
  const { pathname } = useLocation();
  const past = pathname.replace(/\/+$/, '') === '/events/past';
  const { person } = useAuth();
  const isStaff = person?.accountLevel === 'staff' || person?.accountLevel === 'administrator';

  const tabClass = (active: boolean) =>
    cn(
      'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
      active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
    );

  return (
    <>
      {/* specs/behaviors/app-shell.md → /events has no trail; /events/past is Events › Past */}
      {past && <Breadcrumbs items={[{ label: 'Events', href: '/events' }, { label: 'Past' }]} />}
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">Events</h1>
            <p className="mt-2 max-w-2xl text-muted-foreground">
              Code for Philly meets in person every month. RSVP so we know you&rsquo;re coming, and subscribe to
              get every event on your own calendar.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <SubscribeControl />
            {isStaff && (
              <Button asChild>
                <Link to="/events/new">New event</Link>
              </Button>
            )}
          </div>
        </header>

        <nav aria-label="Event views" className="mb-6 flex gap-1 border-b border-border">
          <Link to="/events" className={tabClass(!past)} aria-current={!past ? 'page' : undefined}>
            Upcoming
          </Link>
          <Link to="/events/past" className={tabClass(past)} aria-current={past ? 'page' : undefined}>
            Past
          </Link>
        </nav>

        {past ? <PastList /> : <UpcomingList isStaff={isStaff} />}
      </div>
    </>
  );
}
