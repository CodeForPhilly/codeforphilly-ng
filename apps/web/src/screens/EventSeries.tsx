import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { EventCard } from '@/components/EventCard';
import { MarkdownEditor } from '@/components/MarkdownEditor';
import { MarkdownView } from '@/components/MarkdownView';
import { api, ApiError, type EventSeriesDetail, type UpdateEventSeriesInput } from '@/lib/api';

/** Staff dialog: title, description, and (under Advanced) slug. */
function EditSeriesDialog({
  series,
  open,
  onOpenChange,
  onSaved,
}: {
  series: EventSeriesDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (slug: string) => void;
}) {
  const [title, setTitle] = useState(series.title);
  const [description, setDescription] = useState(series.description ?? '');
  const [slug, setSlug] = useState(series.slug);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const save = async () => {
    if (!title.trim()) {
      setErrors({ title: 'Title is required.' });
      return;
    }
    const payload: UpdateEventSeriesInput = {};
    if (title.trim() !== series.title) payload.title = title.trim();
    const desc = description.trim() === '' ? null : description;
    if (desc !== series.description) payload.description = desc;
    if (slug.trim() && slug.trim() !== series.slug) payload.slug = slug.trim();
    if (Object.keys(payload).length === 0) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      const saved = (await api.eventSeries.update(series.slug, payload)).data;
      toast.success('Series saved');
      onSaved(saved.slug);
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = { ...(err.fields ?? {}) };
        if (err.code === 'slug_taken' || err.code === 'slug_reserved') {
          fields['slug'] = fields['slug'] ?? err.message;
          setAdvancedOpen(true);
        }
        setErrors(fields);
        toast.error(err.message || 'Save failed');
      } else {
        toast.error("Couldn't save. Try again or check your connection.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit series</DialogTitle>
          <DialogDescription>Changes show on this page and on every event in the series.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="series-title">Title</Label>
            <Input
              id="series-title"
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-invalid={!!errors['title']}
              aria-describedby={errors['title'] ? 'series-title-error' : undefined}
            />
            {errors['title'] && (
              <p id="series-title-error" role="alert" className="text-sm text-destructive">
                {errors['title']}
              </p>
            )}
          </div>
          <MarkdownEditor
            label="Description"
            value={description}
            maxLength={10000}
            minHeight={120}
            onChange={setDescription}
            error={errors['description']}
          />
          <details
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
            className="rounded-md border border-border px-4 py-3"
          >
            <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
            <div className="mt-3 space-y-1.5">
              <Label htmlFor="series-slug">Slug</Label>
              <Input
                id="series-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                aria-invalid={!!errors['slug']}
                aria-describedby={['series-slug-help', errors['slug'] ? 'series-slug-error' : null]
                  .filter(Boolean)
                  .join(' ')}
              />
              <p id="series-slug-help" className="text-xs text-muted-foreground">
                Changing this redirects the old link for 90 days.
              </p>
              {errors['slug'] && (
                <p id="series-slug-error" role="alert" className="text-sm text-destructive">
                  {errors['slug']}
                </p>
              )}
            </div>
          </details>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EventSeries() {
  const params = useParams();
  const slug = params['slug']!;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const q = useQuery({
    queryKey: ['event-series', slug],
    queryFn: () => api.eventSeries.get(slug),
  });

  if (q.isLoading) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading series…</div>;
  }
  if (q.isError || !q.data) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <div className="container mx-auto px-4 py-16 text-center">
          <h1 className="mb-2 text-2xl font-bold">Series not found</h1>
          <p className="mb-6 text-muted-foreground">No event series with the slug “{slug}” exists.</p>
          <Link to="/events" className="text-primary hover:underline">
            ← See all events
          </Link>
        </div>
      );
    }
    return <div className="container mx-auto px-4 py-12 text-destructive">Failed to load series.</div>;
  }

  const series = q.data.data;
  const perms = series.permissions;

  const doDelete = async () => {
    setDeleting(true);
    try {
      await api.eventSeries.remove(series.slug);
      toast.success('Series deleted');
      await queryClient.invalidateQueries({ queryKey: ['event-series'] });
      void navigate('/events');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'has_events') {
        toast.error('Remove its events from the series first.');
        void q.refetch();
      } else {
        toast.error(err instanceof ApiError ? err.message : "Couldn't delete the series.");
      }
      setDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Breadcrumbs items={[{ label: 'Events', href: '/events' }, { label: series.title }]} />
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <p className="mb-1 text-sm text-muted-foreground">Event series</p>
            <h1 className="text-3xl font-bold md:text-4xl">{series.title}</h1>
            {series.descriptionHtml && <MarkdownView html={series.descriptionHtml} className="mt-4" />}
          </div>
          {perms.canEdit && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to={`/events/new?series=${encodeURIComponent(series.slug)}`}>New event in this series</Link>
              </Button>
              {perms.canDelete ? (
                <Button variant="outline" size="sm" className="text-destructive" onClick={() => setDeleteOpen(true)}>
                  Delete
                </Button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* A disabled button swallows pointer events; the span keeps the tooltip reachable. */}
                    <span tabIndex={0}>
                      <Button variant="outline" size="sm" disabled>
                        Delete
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Remove its events from the series first</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </header>

        <section className="mb-10">
          <h2 className="mb-3 text-xl font-semibold">Upcoming</h2>
          {series.upcoming.length === 0 ? (
            <p className="text-muted-foreground">Nothing scheduled yet in this series.</p>
          ) : (
            <div className="space-y-3">
              {series.upcoming.map((e) => (
                <EventCard key={e.id} event={e} />
              ))}
            </div>
          )}
        </section>

        {series.past.length > 0 && (
          <section>
            <h2 className="mb-3 text-xl font-semibold">Past</h2>
            <div className="space-y-3">
              {series.past.map((e) => (
                <EventCard key={e.id} event={e} />
              ))}
            </div>
          </section>
        )}

        {editOpen && (
          <EditSeriesDialog
            series={series}
            open={editOpen}
            onOpenChange={setEditOpen}
            onSaved={(newSlug) => {
              setEditOpen(false);
              void queryClient.invalidateQueries({ queryKey: ['event-series'] });
              if (newSlug !== series.slug) void navigate(`/events/series/${newSlug}`, { replace: true });
            }}
          />
        )}

        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this series?</DialogTitle>
              <DialogDescription>“{series.title}” will be removed permanently.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
                Keep series
              </Button>
              <Button variant="destructive" onClick={() => void doDelete()} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete series'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
