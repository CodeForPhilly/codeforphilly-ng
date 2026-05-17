import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { MarkdownEditor } from '@/components/MarkdownEditor';
import { TagPicker } from '@/components/TagPicker';
import { STAGES, type Stage } from '@/components/StageBadge';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError, type CreateProjectInput, type ProjectDetail } from '@/lib/api';
import { slugify } from '@/lib/slug';

interface ProjectEditProps {
  mode: 'create' | 'edit';
}

interface FormState {
  title: string;
  slug: string;
  summary: string;
  overview: string;
  stage: Stage;
  usersUrl: string;
  developersUrl: string;
  chatChannel: string;
  tagsTopic: string[];
  tagsTech: string[];
  tagsEvent: string[];
  featured: boolean;
}

function initialForm(project?: ProjectDetail): FormState {
  return {
    title: project?.title ?? '',
    slug: project?.slug ?? '',
    summary: project?.summary ?? '',
    overview: project?.overview ?? '',
    stage: (project?.stage as Stage) ?? 'commenting',
    usersUrl: project?.links.usersUrl ?? '',
    developersUrl: project?.links.developersUrl ?? '',
    chatChannel: project?.links.chatChannel ?? '',
    tagsTopic: project?.tags.topic.map((t) => t.slug) ?? [],
    tagsTech: project?.tags.tech.map((t) => t.slug) ?? [],
    tagsEvent: project?.tags.event.map((t) => t.slug) ?? [],
    featured: project?.featured ?? false,
  };
}

export function ProjectEdit({ mode }: ProjectEditProps) {
  const navigate = useNavigate();
  const params = useParams();
  const slug = params['slug'];
  const { person, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const isStaff =
    person?.accountLevel === 'staff' || person?.accountLevel === 'administrator';
  const isAdmin = person?.accountLevel === 'administrator';

  const projectQ = useQuery({
    queryKey: ['project', slug],
    queryFn: () => api.projects.get(slug!),
    enabled: mode === 'edit' && !!slug,
  });

  const [form, setForm] = useState<FormState>(() => initialForm());
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(mode === 'edit');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // Track which loaded-project we've hydrated from so we don't loop.
  const [hydratedFromSlug, setHydratedFromSlug] = useState<string | null>(null);

  // Hydrate form from server data — done in render via state-sync pattern so
  // we avoid the cascading-rerender flagged by react-hooks/set-state-in-effect.
  if (mode === 'edit' && projectQ.data && hydratedFromSlug !== projectQ.data.data.slug) {
    setHydratedFromSlug(projectQ.data.data.slug);
    setForm(initialForm(projectQ.data.data));
  }

  // Auto-slug from title on create: derive on title change rather than effect.
  const [lastTitleForSlug, setLastTitleForSlug] = useState<string>(form.title);
  if (mode === 'create' && !slugManuallyEdited && form.title !== lastTitleForSlug) {
    setLastTitleForSlug(form.title);
    setForm((f) => ({ ...f, slug: slugify(f.title) }));
  }

  // Slug availability check (debounced)
  const [slugAvailability, setSlugAvailability] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const editingExistingSlug =
    mode === 'edit' && projectQ.data?.data.slug === form.slug;
  useEffect(() => {
    if (!form.slug || editingExistingSlug) {
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled) return;
      setSlugAvailability('checking');
      api.projects
        .get(form.slug)
        .then(() => {
          if (!cancelled) setSlugAvailability('taken');
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 404) {
            setSlugAvailability('available');
          } else {
            setSlugAvailability('idle');
          }
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [form.slug, editingExistingSlug]);

  if (authLoading) {
    return (
      <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading…</div>
    );
  }

  if (!person) {
    const returnTo =
      mode === 'create' ? '/projects/create' : `/projects/${slug}/edit`;
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-3">Sign in required</h1>
        <p className="text-muted-foreground mb-6">
          You need to sign in to {mode === 'create' ? 'create a project' : 'edit this project'}.
        </p>
        <Button asChild>
          <Link to={`/login?return=${encodeURIComponent(returnTo)}`}>Sign in</Link>
        </Button>
      </div>
    );
  }

  if (mode === 'edit' && projectQ.isLoading) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading project…</div>;
  }

  if (mode === 'edit' && projectQ.isError) {
    return <div className="container mx-auto px-4 py-12 text-destructive">Failed to load project.</div>;
  }

  const project = projectQ.data?.data;

  if (mode === 'edit' && project && !project.permissions.canEdit) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-3">Not authorized</h1>
        <p className="text-muted-foreground mb-6">
          You don't have permission to edit this project.
        </p>
        <Button asChild variant="outline">
          <Link to={`/projects/${slug}`}>Back to project</Link>
        </Button>
      </div>
    );
  }

  // Slug editable: create always, edit only staff
  const slugEditable = mode === 'create' || isStaff;

  const onCancel = () => {
    void navigate(mode === 'create' ? '/projects' : `/projects/${slug}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setSubmitting(true);

    const payload: CreateProjectInput = {
      title: form.title.trim(),
      summary: form.summary.trim() || null,
      overview: form.overview.trim() || null,
      stage: form.stage,
      usersUrl: form.usersUrl.trim() || null,
      developersUrl: form.developersUrl.trim() || null,
      chatChannel: form.chatChannel.trim() || null,
      tags: {
        topic: form.tagsTopic,
        tech: form.tagsTech,
        event: form.tagsEvent,
      },
    };
    if (slugEditable && form.slug) payload.slug = form.slug;
    if (isStaff) payload.featured = form.featured;

    try {
      if (mode === 'create') {
        const res = await api.projects.create(payload);
        await queryClient.invalidateQueries({ queryKey: ['projects'] });
        toast.success('Project created');
        void navigate(`/projects/${res.data.slug}`);
      } else {
        const res = await api.projects.update(slug!, payload);
        await queryClient.invalidateQueries({ queryKey: ['project', slug] });
        await queryClient.invalidateQueries({ queryKey: ['projects'] });
        toast.success('Project saved');
        void navigate(`/projects/${res.data.slug}`);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setFieldErrors(err.fields);
        toast.error(err.message || 'Save failed');
      } else {
        toast.error("Couldn't save. Try again or check your connection.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!project) return;
    const confirm = window.prompt(
      `Type the project slug "${project.slug}" to confirm deletion:`,
    );
    if (confirm !== project.slug) {
      if (confirm !== null) toast.error('Slug did not match — deletion cancelled');
      return;
    }
    try {
      await api.projects.delete(project.slug);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project deleted', {
        action: {
          label: 'Undo',
          onClick: () => {
            api.projects
              .restore(project.slug)
              .then(() => {
                void queryClient.invalidateQueries({ queryKey: ['projects'] });
                toast.success('Project restored');
              })
              .catch(() => toast.error('Restore failed'));
          },
        },
      });
      void navigate('/projects');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Delete failed');
    }
  };

  const slugIndicator =
    slugAvailability === 'checking'
      ? 'Checking…'
      : slugAvailability === 'available'
        ? '✓ Available'
        : slugAvailability === 'taken'
          ? '✗ Taken'
          : '';

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">
          {mode === 'create' ? 'New project' : `Edit project: ${project?.title ?? ''}`}
        </h1>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" form="project-form" disabled={submitting || !form.title.trim()}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </header>

      <form id="project-form" onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-1.5">
          <Label htmlFor="title">
            Title <span className="text-destructive">*</span>
          </Label>
          <Input
            id="title"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            maxLength={200}
            required
            aria-invalid={fieldErrors['title'] ? 'true' : 'false'}
          />
          {fieldErrors['title'] && (
            <p className="text-xs text-destructive">{fieldErrors['title']}</p>
          )}
        </div>

        {slugEditable && (
          <div className="space-y-1.5">
            <Label htmlFor="slug">
              Slug <span className="text-destructive">*</span>
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="slug"
                value={form.slug}
                onChange={(e) => {
                  setSlugManuallyEdited(true);
                  setForm((f) => ({ ...f, slug: e.target.value }));
                }}
                pattern="^[a-z0-9][a-z0-9-_]{1,79}$"
                required
                className="flex-1"
              />
              <span
                className={
                  slugAvailability === 'available'
                    ? 'text-xs text-green-600'
                    : slugAvailability === 'taken'
                      ? 'text-xs text-destructive'
                      : 'text-xs text-muted-foreground'
                }
              >
                {slugIndicator}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              URL: /projects/<strong>{form.slug || 'your-slug'}</strong>
            </p>
            {fieldErrors['slug'] && (
              <p className="text-xs text-destructive">{fieldErrors['slug']}</p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="summary">Summary</Label>
          <Input
            id="summary"
            value={form.summary}
            onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
            maxLength={280}
            placeholder="A one-line description"
          />
          <p className="text-xs text-muted-foreground text-right">
            {form.summary.length} / 280
          </p>
        </div>

        <MarkdownEditor
          label="Overview"
          description="Long-form project description. Markdown supported."
          value={form.overview}
          onChange={(v) => setForm((f) => ({ ...f, overview: v }))}
          error={fieldErrors['overview']}
        />

        <div className="space-y-1.5">
          <Label htmlFor="stage">
            Stage <span className="text-destructive">*</span>
          </Label>
          <Select
            value={form.stage}
            onValueChange={(v) => setForm((f) => ({ ...f, stage: v as Stage }))}
          >
            <SelectTrigger id="stage" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(STAGES) as [Stage, (typeof STAGES)[Stage]][]).map(
                ([key, meta]) => (
                  <SelectItem key={key} value={key}>
                    {meta.label} — {meta.description}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="usersUrl">Users' site URL</Label>
            <Input
              id="usersUrl"
              type="url"
              value={form.usersUrl}
              onChange={(e) => setForm((f) => ({ ...f, usersUrl: e.target.value }))}
              placeholder="https://"
            />
            {fieldErrors['usersUrl'] && (
              <p className="text-xs text-destructive">{fieldErrors['usersUrl']}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="developersUrl">Developers' site URL</Label>
            <Input
              id="developersUrl"
              type="url"
              value={form.developersUrl}
              onChange={(e) => setForm((f) => ({ ...f, developersUrl: e.target.value }))}
              placeholder="https://"
            />
            {fieldErrors['developersUrl'] && (
              <p className="text-xs text-destructive">{fieldErrors['developersUrl']}</p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="chatChannel">Chat channel</Label>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">#</span>
            <Input
              id="chatChannel"
              value={form.chatChannel}
              onChange={(e) => setForm((f) => ({ ...f, chatChannel: e.target.value }))}
              placeholder="my-channel"
            />
          </div>
          {fieldErrors['chatChannel'] && (
            <p className="text-xs text-destructive">{fieldErrors['chatChannel']}</p>
          )}
        </div>

        <TagPicker
          namespace="topic"
          label="Topics"
          value={form.tagsTopic}
          onChange={(v) => setForm((f) => ({ ...f, tagsTopic: v }))}
          allowCreate={isStaff}
        />
        <TagPicker
          namespace="tech"
          label="Tech"
          value={form.tagsTech}
          onChange={(v) => setForm((f) => ({ ...f, tagsTech: v }))}
          allowCreate={isStaff}
        />
        <TagPicker
          namespace="event"
          label="Events"
          value={form.tagsEvent}
          onChange={(v) => setForm((f) => ({ ...f, tagsEvent: v }))}
          allowCreate={isStaff}
        />

        {isStaff && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.featured}
              onCheckedChange={(v) => setForm((f) => ({ ...f, featured: Boolean(v) }))}
            />
            Featured (appears on home page)
          </label>
        )}

        {mode === 'edit' && isAdmin && project && (
          <div className="border border-destructive/40 rounded-md p-4 mt-8">
            <h2 className="text-base font-semibold text-destructive mb-2">Danger zone</h2>
            <p className="text-sm text-muted-foreground mb-3">
              Soft-delete this project. Staff can restore from the projects list.
            </p>
            <Button type="button" variant="destructive" onClick={handleDelete}>
              Delete project
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
