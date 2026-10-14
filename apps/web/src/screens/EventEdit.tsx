import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { MarkdownEditor } from '@/components/MarkdownEditor';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError, type CreateEventInput, type EventDetail, type UpdateEventInput } from '@/lib/api';
import {
  addMinutesToWallClock,
  phillyWallClockToUtc,
  shiftOneMonthInPhilly,
  utcToPhillyWallClock,
} from '@/lib/event-time';
import { slugify } from '@/lib/slug';

interface EventEditProps {
  mode: 'create' | 'edit';
}

interface FormState {
  title: string;
  startsDate: string;
  startsTime: string;
  endsDate: string;
  endsTime: string;
  venueName: string;
  venueAddress: string;
  onlineUrl: string;
  meetupUrl: string;
  description: string;
  slug: string;
  status: 'scheduled' | 'draft';
}

/** A hack night runs 2h30; the end defaults to that after the start. */
const DEFAULT_DURATION_MINUTES = 150;
const ENDS_BEFORE_STARTS = 'Ends must be after Starts.';

const EMPTY_FORM: FormState = {
  title: '',
  startsDate: '',
  startsTime: '',
  endsDate: '',
  endsTime: '',
  venueName: '',
  venueAddress: '',
  onlineUrl: '',
  meetupUrl: '',
  description: '',
  slug: '',
  status: 'scheduled',
};

function formFromEvent(e: EventDetail, opts: { duplicate: boolean }): FormState {
  const startsAt = opts.duplicate ? shiftOneMonthInPhilly(e.startsAt) : e.startsAt;
  const endsAt = opts.duplicate ? shiftOneMonthInPhilly(e.endsAt) : e.endsAt;
  const s = utcToPhillyWallClock(startsAt);
  const en = utcToPhillyWallClock(endsAt);
  return {
    title: e.title,
    startsDate: s.date,
    startsTime: s.time,
    endsDate: en.date,
    endsTime: en.time,
    venueName: e.venueName ?? '',
    venueAddress: e.venueAddress ?? '',
    onlineUrl: e.onlineUrl ?? '',
    meetupUrl: e.meetupUrl ?? '',
    description: e.description ?? '',
    slug: opts.duplicate ? '' : e.slug,
    status: 'scheduled',
  };
}

const orNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive" role="alert">
      {message}
    </p>
  );
}

export function EventEdit({ mode }: EventEditProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const editSlug = params['slug'];
  const [searchParams] = useSearchParams();
  const fromSlug = mode === 'create' ? searchParams.get('from') : null;
  const { person, loading: authLoading } = useAuth();
  const isStaff = person?.accountLevel === 'staff' || person?.accountLevel === 'administrator';

  const sourceSlug = mode === 'edit' ? editSlug : fromSlug;
  const sourceQ = useQuery({
    queryKey: ['event', sourceSlug],
    queryFn: () => api.events.get(sourceSlug!),
    enabled: !!sourceSlug && isStaff,
  });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [hydratedFrom, setHydratedFrom] = useState<string | null>(null);
  const [endsTouched, setEndsTouched] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showDuplicateNote, setShowDuplicateNote] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Hydrate from the loaded source during render (state-sync pattern, as in ProjectEdit).
  const source = sourceQ.data?.data;
  if (source && hydratedFrom !== source.slug) {
    setHydratedFrom(source.slug);
    setForm(formFromEvent(source, { duplicate: mode === 'create' }));
    setEndsTouched(true);
  }

  const update = (patch: Partial<FormState>) => {
    setDirty(true);
    setForm((f) => {
      const next = { ...f, ...patch };
      const startChanged = 'startsDate' in patch || 'startsTime' in patch;
      if (startChanged && !endsTouched && next.startsDate && next.startsTime) {
        const end = addMinutesToWallClock(next.startsDate, next.startsTime, DEFAULT_DURATION_MINUTES);
        if (end) {
          next.endsDate = end.date;
          next.endsTime = end.time;
        }
      }
      return next;
    });
  };
  const updateEnds = (patch: Partial<FormState>) => {
    setEndsTouched(true);
    update(patch);
  };

  if (authLoading) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading…</div>;
  }

  if (!isStaff) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="mb-3 text-2xl font-bold">403 — Not authorized</h1>
        <p className="mb-6 text-muted-foreground">Only staff can create or edit events.</p>
        <Button asChild variant="outline">
          <Link to="/events">Back to events</Link>
        </Button>
      </div>
    );
  }

  if (sourceSlug && sourceQ.isLoading) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading event…</div>;
  }
  if (sourceSlug && (sourceQ.isError || !source)) {
    const notFound = sourceQ.error instanceof ApiError && sourceQ.error.status === 404;
    return (
      <div className="container mx-auto px-4 py-12 text-destructive">
        {notFound ? `No event with the slug “${sourceSlug}” exists.` : 'Failed to load event.'}
      </div>
    );
  }

  const startsAt = phillyWallClockToUtc(form.startsDate, form.startsTime);
  const endsAt = phillyWallClockToUtc(form.endsDate, form.endsTime);

  // "Save and notify N attendees" when a time/location change on a scheduled
  // event with RSVPs will email everyone (behaviors/events.md).
  const timeOrPlaceChanged =
    !!source &&
    (startsAt !== source.startsAt ||
      endsAt !== source.endsAt ||
      orNull(form.venueName) !== source.venueName ||
      orNull(form.venueAddress) !== source.venueAddress ||
      orNull(form.onlineUrl) !== source.onlineUrl);
  const notifyCount =
    mode === 'edit' && source?.status === 'scheduled' && timeOrPlaceChanged ? source.rsvpCount : 0;

  const defaultSlug = form.startsDate && form.title ? `${form.startsDate}-${slugify(form.title)}` : '2026-11-03-hack-night';

  const onCancel = () => {
    if (dirty && !window.confirm('Discard your changes?')) return;
    void navigate(mode === 'edit' && source ? `/events/${source.slug}` : '/events');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!form.title.trim()) errors['title'] = 'Title is required.';
    if (!startsAt) errors['startsAt'] = 'Start date and time are required.';
    if (!endsAt) errors['endsAt'] = 'End date and time are required.';
    else if (startsAt && new Date(endsAt) <= new Date(startsAt)) errors['endsAt'] = ENDS_BEFORE_STARTS;
    setFieldErrors(errors);
    if (Object.keys(errors).length || !startsAt || !endsAt) return;

    setSubmitting(true);
    try {
      let saved: EventDetail;
      if (mode === 'create') {
        const payload: CreateEventInput = {
          title: form.title.trim(),
          description: orNull(form.description),
          startsAt,
          endsAt,
          venueName: orNull(form.venueName),
          venueAddress: orNull(form.venueAddress),
          onlineUrl: orNull(form.onlineUrl),
          meetupUrl: orNull(form.meetupUrl),
          status: form.status,
        };
        if (form.slug.trim()) payload.slug = form.slug.trim();
        // Duplicate mode keeps the source's series (behaviors/events.md#duplicating).
        if (source?.series) payload.seriesSlug = source.series.slug;
        saved = (await api.events.create(payload)).data;
        toast.success(form.status === 'draft' ? 'Draft saved' : 'Event published');
      } else {
        const orig = source!;
        const payload: UpdateEventInput = {};
        if (form.title.trim() !== orig.title) payload.title = form.title.trim();
        if (form.slug.trim() && form.slug.trim() !== orig.slug) payload.slug = form.slug.trim();
        if (form.description !== (orig.description ?? '')) payload.description = orNull(form.description);
        if (startsAt !== orig.startsAt) payload.startsAt = startsAt;
        if (endsAt !== orig.endsAt) payload.endsAt = endsAt;
        if (orNull(form.venueName) !== orig.venueName) payload.venueName = orNull(form.venueName);
        if (orNull(form.venueAddress) !== orig.venueAddress) payload.venueAddress = orNull(form.venueAddress);
        if (orNull(form.onlineUrl) !== orig.onlineUrl) payload.onlineUrl = orNull(form.onlineUrl);
        if (orNull(form.meetupUrl) !== orig.meetupUrl) payload.meetupUrl = orNull(form.meetupUrl);
        saved = (await api.events.update(orig.slug, payload)).data;
        await queryClient.invalidateQueries({ queryKey: ['event', orig.slug] });
        toast.success(notifyCount ? `Saved — notifying ${notifyCount} attendees` : 'Event saved');
      }
      await queryClient.invalidateQueries({ queryKey: ['events'] });
      setDirty(false);
      void navigate(`/events/${saved.slug}`);
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = { ...(err.fields ?? {}) };
        if (fields['endsAt'] === 'must be after startsAt') fields['endsAt'] = ENDS_BEFORE_STARTS;
        if (err.code === 'slug_taken' || err.code === 'slug_reserved') {
          fields['slug'] = fields['slug'] ?? err.message;
          setAdvancedOpen(true);
        }
        setFieldErrors(fields);
        toast.error(err.message || 'Save failed');
      } else {
        toast.error("Couldn't save. Try again or check your connection.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const breadcrumbs =
    mode === 'edit' && source
      ? [
          { label: 'Events', href: '/events' },
          { label: source.title, href: `/events/${source.slug}` },
          { label: 'Edit' },
        ]
      : [{ label: 'Events', href: '/events' }, { label: 'New event' }];

  const err = (k: string) => fieldErrors[k];
  const describedBy = (k: string, extra?: string) =>
    [err(k) ? `${k}-error` : null, extra].filter(Boolean).join(' ') || undefined;

  return (
    <>
      <Breadcrumbs items={breadcrumbs} />
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">
          {mode === 'create' ? 'New event' : `Edit event: ${source?.title ?? ''}`}
        </h1>

        {mode === 'create' && source && showDuplicateNote && (
          <div
            role="status"
            className="mb-6 flex items-start justify-between gap-3 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-900"
          >
            <span>
              Copied from {source.title}. Check the date.
            </span>
            <button
              type="button"
              aria-label="Dismiss"
              className="text-blue-900/70 hover:text-blue-900"
              onClick={() => setShowDuplicateNote(false)}
            >
              ×
            </button>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="event-title">Title</Label>
            <Input
              id="event-title"
              required
              maxLength={200}
              value={form.title}
              onChange={(e) => update({ title: e.target.value })}
              aria-invalid={!!err('title')}
              aria-describedby={describedBy('title')}
            />
            <FieldError id="title-error" message={err('title')} />
          </div>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Starts (Philadelphia time)</legend>
            <div className="flex flex-wrap gap-2">
              <Input
                type="date"
                aria-label="Start date"
                className="w-auto"
                value={form.startsDate}
                onChange={(e) => update({ startsDate: e.target.value })}
                aria-invalid={!!err('startsAt')}
                aria-describedby={describedBy('startsAt')}
              />
              <Input
                type="time"
                aria-label="Start time"
                className="w-auto"
                value={form.startsTime}
                onChange={(e) => update({ startsTime: e.target.value })}
              />
            </div>
            <FieldError id="startsAt-error" message={err('startsAt')} />
          </fieldset>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Ends (Philadelphia time)</legend>
            <div className="flex flex-wrap gap-2">
              <Input
                type="date"
                aria-label="End date"
                className="w-auto"
                value={form.endsDate}
                onChange={(e) => updateEnds({ endsDate: e.target.value })}
                aria-invalid={!!err('endsAt')}
                aria-describedby={describedBy('endsAt')}
              />
              <Input
                type="time"
                aria-label="End time"
                className="w-auto"
                value={form.endsTime}
                onChange={(e) => updateEnds({ endsTime: e.target.value })}
              />
            </div>
            <FieldError id="endsAt-error" message={err('endsAt')} />
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="event-venue-name">Venue name</Label>
            <Input
              id="event-venue-name"
              maxLength={120}
              value={form.venueName}
              onChange={(e) => update({ venueName: e.target.value })}
              aria-describedby={describedBy('venueName')}
            />
            <FieldError id="venueName-error" message={err('venueName')} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="event-venue-address">Venue address</Label>
            <Input
              id="event-venue-address"
              maxLength={300}
              value={form.venueAddress}
              onChange={(e) => update({ venueAddress: e.target.value })}
              aria-describedby={describedBy('venueAddress', 'event-venue-address-help')}
            />
            <p id="event-venue-address-help" className="text-xs text-muted-foreground">
              Shown as a Google Maps link.
            </p>
            <FieldError id="venueAddress-error" message={err('venueAddress')} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="event-online-url">Online link</Label>
            <Input
              id="event-online-url"
              type="url"
              placeholder="https://"
              value={form.onlineUrl}
              onChange={(e) => update({ onlineUrl: e.target.value })}
              aria-describedby={describedBy('onlineUrl')}
            />
            <FieldError id="onlineUrl-error" message={err('onlineUrl')} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="event-meetup-url">Meetup link</Label>
            <Input
              id="event-meetup-url"
              type="url"
              placeholder="https://www.meetup.com/…"
              value={form.meetupUrl}
              onChange={(e) => update({ meetupUrl: e.target.value })}
              aria-describedby={describedBy('meetupUrl', 'event-meetup-url-help')}
            />
            <p id="event-meetup-url-help" className="text-xs text-muted-foreground">
              Shown as a secondary link while we transition off Meetup.
            </p>
            <FieldError id="meetupUrl-error" message={err('meetupUrl')} />
          </div>

          <MarkdownEditor
            label="Description"
            value={form.description}
            maxLength={20000}
            onChange={(v) => update({ description: v })}
            error={err('description')}
          />

          <details
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
            className="rounded-md border border-border px-4 py-3"
          >
            <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
            <div className="mt-3 space-y-1.5">
              <Label htmlFor="event-slug">Slug</Label>
              <Input
                id="event-slug"
                value={form.slug}
                placeholder={mode === 'create' ? defaultSlug : undefined}
                onChange={(e) => update({ slug: e.target.value })}
                aria-invalid={!!err('slug')}
                aria-describedby={describedBy('slug', mode === 'edit' ? 'event-slug-help' : undefined)}
              />
              {mode === 'edit' && (
                <p id="event-slug-help" className="text-xs text-muted-foreground">
                  Changing this redirects the old link for 90 days.
                </p>
              )}
              <FieldError id="slug-error" message={err('slug')} />
            </div>
          </details>

          {mode === 'create' ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Save as</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="status"
                  value="scheduled"
                  checked={form.status === 'scheduled'}
                  onChange={() => update({ status: 'scheduled' })}
                />
                Publish now
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="status"
                  value="draft"
                  checked={form.status === 'draft'}
                  onChange={() => update({ status: 'draft' })}
                />
                Save as draft
              </label>
            </fieldset>
          ) : (
            <p className="text-sm text-muted-foreground">
              Status: <span className="font-medium capitalize text-foreground">{source?.status}</span>. Cancelling
              happens from the event page.
            </p>
          )}

          {notifyCount > 0 && (
            <p className="text-sm text-muted-foreground">
              You changed the time or location. Everyone who RSVP&rsquo;d gets an &ldquo;Event updated&rdquo; email
              with the new details and a refreshed calendar file.
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : notifyCount > 0 ? `Save and notify ${notifyCount} attendees` : 'Save'}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
