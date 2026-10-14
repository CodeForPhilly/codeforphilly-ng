import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { MarkdownView } from '@/components/MarkdownView';
import { PersonAvatar } from '@/components/PersonAvatar';
import { useAuth } from '@/hooks/useAuth';
import {
  api,
  ApiError,
  type EventAgendaItem,
  type EventDetail as EventDetailData,
  type EventRsvpInput,
  type EventRsvpPlan,
  type SuccessEnvelope,
} from '@/lib/api';
import { copyWithToast } from '@/lib/clipboard';
import { groupAttendees } from '@/lib/event-attendees';
import {
  agendaDayHeading,
  formatCompactRange,
  formatEventTime,
  googleCalendarUrl,
  isPastEvent,
} from '@/lib/event-time';
import { formatAbsoluteDate, formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------

const PLAN_LABELS: Record<Exclude<EventRsvpPlan, 'project'>, string> = {
  newcomer: 'I’m new to Code for Philly',
  no_project: 'I don’t have a project yet',
};

interface FollowUpProps {
  plan: EventRsvpPlan | null;
  project: { slug: string; title: string } | null;
  busy: boolean;
  onSave: (input: EventRsvpInput) => Promise<void>;
}

function FollowUp({ plan, project, busy, onSave }: FollowUpProps) {
  const [changing, setChanging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const projectsQ = useQuery({
    queryKey: ['projects', { perPage: 100, sort: 'title' }],
    queryFn: () => api.projects.list({ perPage: 100, sort: 'title' }),
    enabled: pickerOpen,
  });

  const save = async (input: EventRsvpInput) => {
    await onSave(input);
    setChanging(false);
    setPickerOpen(false);
  };

  if (plan !== null && !changing) {
    const label = plan === 'project' ? `I’m coming to work on ${project?.title ?? 'a project'}` : PLAN_LABELS[plan];
    return (
      <div className="mt-4 text-sm">
        <p className="text-muted-foreground">What are you coming to do?</p>
        <p className="mt-1 flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-primary bg-primary/5 px-3 py-1.5 font-medium" aria-current="true">
            {label}
          </span>
          <button type="button" className="text-primary hover:underline" onClick={() => setChanging(true)}>
            Change
          </button>
        </p>
      </div>
    );
  }

  const choiceClass =
    'rounded-md border border-border px-3 py-1.5 text-left hover:bg-accent disabled:opacity-60';

  return (
    <fieldset className="mt-4 text-sm" disabled={busy}>
      <legend className="text-muted-foreground">What are you coming to do? (optional)</legend>
      <div className="mt-2 flex flex-col gap-2 sm:items-start">
        <button type="button" className={choiceClass} onClick={() => void save({ plan: 'newcomer' })}>
          {PLAN_LABELS.newcomer}
        </button>
        <button type="button" className={choiceClass} onClick={() => void save({ plan: 'no_project' })}>
          {PLAN_LABELS.no_project}
        </button>
        {pickerOpen ? (
          <label className="flex flex-wrap items-center gap-2">
            <span>I&rsquo;m coming to work on</span>
            <select
              className="rounded-md border border-input bg-background px-2 py-1.5"
              defaultValue=""
              aria-label="Pick a project"
              onChange={(e) => {
                if (e.target.value) void save({ plan: 'project', projectSlug: e.target.value });
              }}
            >
              <option value="" disabled>
                {projectsQ.isLoading ? 'Loading projects…' : 'Pick a project'}
              </option>
              {(projectsQ.data?.data ?? []).map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <button type="button" className={choiceClass} onClick={() => setPickerOpen(true)}>
            I&rsquo;m coming to work on [Pick a project ▾]
          </button>
        )}
      </div>
      {changing && (
        <button type="button" className="mt-2 text-xs text-muted-foreground hover:underline" onClick={() => setChanging(false)}>
          Keep my answer
        </button>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Schedule (agenda) — rendered only when present and non-empty
// ---------------------------------------------------------------------------

function Schedule({ agenda, id, className }: { agenda: EventAgendaItem[]; id?: string; className?: string }) {
  const days: Array<{ key: string; weekday: string; date: string; items: EventAgendaItem[] }> = [];
  for (const item of agenda) {
    const h = agendaDayHeading(item.startsAt);
    const last = days[days.length - 1];
    if (last && last.key === h.key) last.items.push(item);
    else days.push({ ...h, items: [item] });
  }
  return (
    <section id={id} className={className}>
      <h2 className="mb-3 text-xl font-semibold">Schedule</h2>
      <div className="space-y-5">
        {days.map((d) => {
          let prevVenue: string | null = null;
          return (
            <div key={d.key}>
              <h3 className="mb-2 text-sm">
                <strong>{d.weekday},</strong> {d.date}
              </h3>
              <ul className="space-y-3">
                {d.items.map((item, i) => {
                  const venue = item.venueName ? [item.venueName, item.venueAddress].filter(Boolean).join(', ') : null;
                  const showVenue = venue !== null && venue !== prevVenue;
                  prevVenue = venue ?? prevVenue;
                  return (
                    <li key={`${item.startsAt}-${i}`} className="text-sm">
                      <div className="flex gap-3">
                        <span className="w-20 shrink-0 text-muted-foreground">
                          {formatCompactRange(item.startsAt, item.endsAt)}
                        </span>
                        <div className="min-w-0">
                          <p className="font-medium">{item.title}</p>
                          {item.descriptionHtml && <MarkdownView html={item.descriptionHtml} className="text-sm" />}
                          {showVenue && (
                            <a
                              href={`https://maps.google.com/?q=${encodeURIComponent(venue)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline"
                            >
                              <span aria-hidden="true">📍 </span>
                              {item.venueName}
                            </a>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function EventDetail() {
  const params = useParams();
  const slug = params['slug']!;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { person } = useAuth();
  const [rsvpBusy, setRsvpBusy] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [staffBusy, setStaffBusy] = useState(false);

  const eventKey = ['event', slug];
  const eventQ = useQuery({
    queryKey: eventKey,
    queryFn: () => api.events.get(slug),
  });
  const rsvpsQ = useQuery({
    queryKey: ['event-rsvps', slug],
    queryFn: () => api.events.rsvps(slug, { perPage: 100 }),
    enabled: eventQ.isSuccess,
  });

  if (eventQ.isLoading) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading event…</div>;
  }
  if (eventQ.isError || !eventQ.data) {
    const err = eventQ.error;
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="container mx-auto px-4 py-16 text-center">
          <h1 className="mb-2 text-2xl font-bold">Event not found</h1>
          <p className="mb-6 text-muted-foreground">No event with the slug “{slug}” exists.</p>
          <Link to="/events" className="text-primary hover:underline">
            ← See all events
          </Link>
        </div>
      );
    }
    return <div className="container mx-auto px-4 py-12 text-destructive">Failed to load event.</div>;
  }

  const event = eventQ.data.data;
  const perms = event.permissions;
  const isStaffView = perms.canEdit;
  const past = isPastEvent(event.endsAt);
  const cancelled = event.status === 'cancelled';
  const draft = event.status === 'draft';
  const rsvpsOpen = event.status === 'scheduled' && !past;
  const going = event.viewerRsvp !== null;
  const agenda = event.agenda ?? [];
  const origin = window.location.origin;

  const patchEvent = (fn: (e: EventDetailData) => EventDetailData) => {
    queryClient.setQueryData<SuccessEnvelope<EventDetailData>>(eventKey, (old) =>
      old ? { ...old, data: fn(old.data) } : old,
    );
  };
  const refreshLists = () => {
    void queryClient.invalidateQueries({ queryKey: ['event-rsvps', slug] });
    void queryClient.invalidateQueries({ queryKey: ['events'] });
  };

  const handleRsvpError = (err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.code === 'rsvp_closed') {
      toast.error('RSVPs are closed for this event.');
      void eventQ.refetch();
      return;
    }
    toast.error(err instanceof ApiError ? err.message : fallback);
  };

  const doRsvp = async () => {
    const before = event;
    // Optimistic: flip to the going state before the round trip.
    patchEvent((e) => ({
      ...e,
      rsvpCount: e.rsvpCount + 1,
      viewerRsvp: { plan: null, project: null, createdAt: new Date().toISOString() },
    }));
    setRsvpBusy(true);
    try {
      const res = await api.events.rsvp(slug, {});
      const { rsvp, rsvpCount, confirmationDelivered } = res.data;
      patchEvent((e) => ({
        ...e,
        rsvpCount,
        viewerRsvp: { plan: rsvp.plan, project: rsvp.project, createdAt: rsvp.createdAt },
      }));
      toast.success(
        confirmationDelivered === false
          ? "You're going — we couldn't send the calendar email, use Add to calendar below."
          : "You're going — check your email for a calendar invite.",
      );
      refreshLists();
    } catch (err) {
      patchEvent(() => before);
      handleRsvpError(err, "Couldn't save your RSVP.");
    } finally {
      setRsvpBusy(false);
    }
  };

  const saveFollowUp = async (input: EventRsvpInput) => {
    setRsvpBusy(true);
    try {
      const res = await api.events.rsvp(slug, input);
      const { rsvp, rsvpCount } = res.data;
      patchEvent((e) => ({
        ...e,
        rsvpCount,
        viewerRsvp: { plan: rsvp.plan, project: rsvp.project, createdAt: rsvp.createdAt },
      }));
      refreshLists();
    } catch (err) {
      handleRsvpError(err, "Couldn't save your answer.");
    } finally {
      setRsvpBusy(false);
    }
  };

  const doWithdraw = async () => {
    setRsvpBusy(true);
    try {
      await api.events.withdrawRsvp(slug);
      patchEvent((e) => ({ ...e, rsvpCount: Math.max(0, e.rsvpCount - 1), viewerRsvp: null }));
      setWithdrawOpen(false);
      toast.success('Your RSVP was withdrawn.');
      refreshLists();
    } catch (err) {
      handleRsvpError(err, "Couldn't withdraw your RSVP.");
    } finally {
      setRsvpBusy(false);
    }
  };

  const runStaff = async (fn: () => Promise<void>) => {
    setStaffBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setStaffBusy(false);
    }
  };

  const doPublish = () =>
    runStaff(async () => {
      const res = await api.events.publish(slug);
      queryClient.setQueryData(eventKey, res);
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      toast.success('Event published');
    });

  const doCancel = () =>
    runStaff(async () => {
      const note = cancelNote.trim();
      const res = await api.events.cancel(slug, note ? { note } : {});
      queryClient.setQueryData(eventKey, res);
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      setCancelOpen(false);
      toast.success('Event cancelled — attendees are being notified.');
    });

  const doDelete = () =>
    runStaff(async () => {
      await api.events.remove(slug);
      await queryClient.invalidateQueries({ queryKey: ['events'] });
      setDeleteOpen(false);
      toast.success('Event deleted');
      void navigate('/events');
    });

  const rsvps = rsvpsQ.data?.data ?? [];
  const groups = groupAttendees(rsvps);
  const mapsHref = event.venueName
    ? `https://maps.google.com/?q=${encodeURIComponent([event.venueName, event.venueAddress].filter(Boolean).join(', '))}`
    : null;

  return (
    <>
      {/* specs/behaviors/app-shell.md → Events › <title> */}
      <Breadcrumbs items={[{ label: 'Events', href: '/events' }, { label: event.title }]} />
      <div className="container mx-auto px-4 py-8">
        {/* Status banner */}
        {cancelled && (
          <div role="status" className="mb-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            <p className="font-semibold">This event has been cancelled.</p>
            {event.cancellationNote && <p className="mt-1">{event.cancellationNote}</p>}
          </div>
        )}
        {draft && (
          <div
            role="status"
            className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-yellow-400 bg-yellow-50 px-4 py-3 text-sm text-yellow-900"
          >
            <span>Draft — only staff can see this event.</span>
            {perms.canPublish && (
              <Button size="sm" variant="outline" disabled={staffBusy} onClick={() => void doPublish()}>
                {staffBusy ? 'Publishing…' : 'Publish'}
              </Button>
            )}
          </div>
        )}
        {past && !cancelled && (
          <div role="status" className="mb-6 rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
            This event has ended.
          </div>
        )}

        {/* Header */}
        <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            {event.series && (
              <p className="mb-1 text-sm text-muted-foreground">
                Part of{' '}
                <Link to={`/events/series/${event.series.slug}`} className="font-semibold hover:underline">
                  {event.series.title}
                </Link>
              </p>
            )}
            <h1 className="text-3xl font-bold md:text-4xl">{event.title}</h1>
            <p className="mt-3 text-lg font-medium">
              {formatEventTime(event.startsAt, event.endsAt, { style: 'long' })}
            </p>
            {agenda.length > 0 && (
              <a href="#schedule" className="text-sm text-primary hover:underline lg:hidden">
                See the schedule ↓
              </a>
            )}
            <div className="mt-3 text-sm">
              {event.venueName && (
                <>
                  <p className="font-semibold">{event.venueName}</p>
                  {event.venueAddress && mapsHref && (
                    <p>
                      <a href={mapsHref} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {event.venueAddress}
                        <span className="sr-only"> (opens in new tab)</span>
                      </a>
                    </p>
                  )}
                </>
              )}
              {event.onlineUrl && (
                <p className={cn(event.venueName && 'mt-1')}>
                  <a href={event.onlineUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    Join online
                  </a>
                </p>
              )}
              {!event.venueName && !event.onlineUrl && (
                <p className="text-muted-foreground">Location to be announced</p>
              )}
            </div>
          </div>

          {isStaffView && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to={`/events/${event.slug}/edit`}>Edit</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to={`/events/new?from=${encodeURIComponent(event.slug)}`}>Duplicate</Link>
              </Button>
              {perms.canCancel && (
                <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)}>
                  Cancel event…
                </Button>
              )}
              {perms.canDelete ? (
                <Button variant="outline" size="sm" className="text-destructive" onClick={() => setDeleteOpen(true)}>
                  Delete
                </Button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* A disabled button swallows pointer events; the span
                        keeps the tooltip reachable. */}
                    <span tabIndex={0}>
                      <Button variant="outline" size="sm" disabled>
                        Delete
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Cancel instead — people have RSVP&rsquo;d</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </header>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          {/* Main column */}
          <div className="space-y-8 lg:col-span-2">
            {/* RSVP block */}
            <section aria-label="RSVP" className="rounded-lg border border-border bg-card p-5">
              {rsvpsOpen && !person && (
                <>
                  <Button asChild size="lg">
                    <Link to={`/login?return=${encodeURIComponent(`/events/${event.slug}`)}`}>Sign in to RSVP</Link>
                  </Button>
                  <p className="mt-2 text-sm text-muted-foreground">Your name will appear on the attendee list.</p>
                </>
              )}
              {rsvpsOpen && person && !going && (
                <>
                  <Button size="lg" disabled={rsvpBusy} onClick={() => void doRsvp()}>
                    I&rsquo;m going
                  </Button>
                  <p className="mt-2 text-sm text-muted-foreground">Your name will appear on the attendee list.</p>
                </>
              )}
              {rsvpsOpen && person && going && (
                <>
                  <p className="flex flex-wrap items-center gap-3">
                    <span className="text-lg font-semibold text-green-700">You&rsquo;re going ✓</span>
                    <button
                      type="button"
                      className="text-sm text-muted-foreground hover:underline"
                      onClick={() => setWithdrawOpen(true)}
                    >
                      Can&rsquo;t make it?
                    </button>
                  </p>
                  <FollowUp
                    plan={event.viewerRsvp?.plan ?? null}
                    project={event.viewerRsvp?.project ?? null}
                    busy={rsvpBusy}
                    onSave={saveFollowUp}
                  />
                </>
              )}
              <p className={cn('text-sm', rsvpsOpen && 'mt-4')}>
                <a href="#attendees" className="text-primary hover:underline">
                  {event.rsvpCount} going
                </a>
              </p>
              {event.meetupUrl && (
                <p className="mt-3 text-xs text-muted-foreground">
                  <a href={event.meetupUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
                    Also listed on Meetup ↗
                  </a>
                </p>
              )}
            </section>

            {/* Add to calendar */}
            {!draft && (
              <section aria-label="Add to calendar" className="flex flex-wrap gap-4 text-sm">
                <a
                  href={googleCalendarUrl(event, origin)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Add to Google Calendar
                </a>
                <a href={event.icsUrl} download className="text-primary hover:underline">
                  Download .ics
                </a>
              </section>
            )}

            {/* About */}
            {event.description.trim() !== '' && (
              <section>
                <h2 className="mb-3 text-xl font-semibold">About</h2>
                <MarkdownView html={event.descriptionHtml} />
              </section>
            )}

            {agenda.length > 0 && <Schedule agenda={agenda} id="schedule" className="lg:hidden" />}
          </div>

          {/* Sidebar */}
          <aside className="space-y-8 lg:col-span-1">
            {agenda.length > 0 && <Schedule agenda={agenda} className="hidden lg:block" />}

            <section id="attendees">
              <h2 className="mb-3 text-lg font-semibold">
                {cancelled ? 'Had planned to go' : 'Going'} ({event.rsvpCount})
              </h2>
              {rsvpsQ.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading attendees…</p>
              ) : groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {past ? 'Nobody RSVP’d.' : 'Nobody has RSVP’d yet. Be the first!'}
                </p>
              ) : (
                <div className="space-y-4">
                  {groups.map((g) => (
                    <div key={g.key}>
                      {g.label && (
                        <h3 className="mb-2 text-sm font-medium">
                          {g.href ? (
                            <Link to={g.href} className="hover:underline">
                              {g.label}
                            </Link>
                          ) : (
                            g.label
                          )}
                        </h3>
                      )}
                      <ul className="flex flex-wrap gap-2">
                        {g.people.map((r, i) => (
                          <li key={r.person.slug ?? `anon-${i}`}>
                            <PersonAvatar person={r.person} size={48} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Share</h2>
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  onClick={() => copyWithToast(`${origin}/events/${event.slug}`, 'Link copied', "Couldn't copy the link")}
                >
                  Copy link
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    copyWithToast(
                      `${event.title} — ${formatEventTime(event.startsAt, event.endsAt)}: ${origin}/events/${event.slug}`,
                      'Slack message copied',
                      "Couldn't copy the message",
                    )
                  }
                >
                  Share to Slack
                </Button>
              </div>
            </section>

            <section className="space-y-1 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Added:</span>{' '}
                <time dateTime={event.createdAt} title={formatAbsoluteDate(event.createdAt)}>
                  {formatRelativeTime(event.createdAt)}
                </time>
              </p>
              {event.updatedAt !== event.createdAt && (
                <p>
                  <span className="font-medium text-foreground">Updated:</span>{' '}
                  <time dateTime={event.updatedAt} title={formatAbsoluteDate(event.updatedAt)}>
                    {formatRelativeTime(event.updatedAt)}
                  </time>
                </p>
              )}
            </section>
          </aside>
        </div>

        {/* Withdraw confirm */}
        <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Withdraw your RSVP?</DialogTitle>
              <DialogDescription>You&rsquo;ll be removed from the attendee list for “{event.title}”.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setWithdrawOpen(false)} disabled={rsvpBusy}>
                Keep my RSVP
              </Button>
              <Button variant="destructive" onClick={() => void doWithdraw()} disabled={rsvpBusy}>
                {rsvpBusy ? 'Withdrawing…' : "I can't make it"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Cancel confirm */}
        <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cancel this event?</DialogTitle>
              <DialogDescription>
                Everyone who RSVP&rsquo;d ({event.rsvpCount}) gets an email. This can&rsquo;t be undone — to bring
                the event back, duplicate it.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="cancel-note">Note to attendees (optional)</Label>
              <Textarea
                id="cancel-note"
                maxLength={500}
                value={cancelNote}
                onChange={(e) => setCancelNote(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={staffBusy}>
                Keep event
              </Button>
              <Button variant="destructive" onClick={() => void doCancel()} disabled={staffBusy}>
                {staffBusy ? 'Cancelling…' : 'Cancel event'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete confirm */}
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this event?</DialogTitle>
              <DialogDescription>“{event.title}” will be removed permanently.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={staffBusy}>
                Keep event
              </Button>
              <Button variant="destructive" onClick={() => void doDelete()} disabled={staffBusy}>
                {staffBusy ? 'Deleting…' : 'Delete event'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
