/**
 * /projects/:slug/buzz/new — log a buzz item.
 *
 * Per specs/api/projects-buzz.md → POST /api/projects/:slug/buzz.
 * Any signed-in user can log buzz on any project (laddr precedent).
 * Anonymous callers are redirected to /login with a return-to back here.
 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError, type CreateBuzzInput } from '@/lib/api';

interface FormState {
  headline: string;
  url: string;
  publishedAt: string;
  summary: string;
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function ProjectBuzzNew() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { person, loading: authLoading } = useAuth();

  const [form, setForm] = useState<FormState>({
    headline: '',
    url: '',
    publishedAt: todayIso(),
    summary: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!slug) return <Navigate to="/projects" replace />;
  if (authLoading) {
    return (
      <div className="container mx-auto px-4 py-8 text-muted-foreground">Loading…</div>
    );
  }
  if (!person) {
    return (
      <Navigate
        to={`/login?return=${encodeURIComponent(`/projects/${slug}/buzz/new`)}`}
        replace
      />
    );
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!slug) return;
    setSubmitting(true);
    setFieldErrors({});
    try {
      const input: CreateBuzzInput = {
        headline: form.headline.trim(),
        url: form.url.trim(),
        publishedAt: form.publishedAt,
        summary: form.summary.trim() ? form.summary.trim() : null,
      };
      await api.projects.postBuzz(slug, input);
      toast.success('Buzz logged');
      navigate(`/projects/${slug}#activity`);
    } catch (err) {
      if (err instanceof ApiError) {
        // Spec carves out `duplicate_url` at 409; surface inline on the URL field.
        if (err.code === 'duplicate_url') {
          setFieldErrors({ url: 'This URL is already logged for this project.' });
        } else if (err.fields) {
          setFieldErrors(err.fields);
        }
        toast.error(err.message || 'Failed to log buzz');
      } else {
        toast.error('Failed to log buzz');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Log Buzz</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Add a press mention, blog post, or external link about{' '}
          <Link to={`/projects/${slug}`} className="text-primary underline hover:no-underline">
            this project
          </Link>
          .
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-1.5">
          <Label htmlFor="headline">
            Headline <span className="text-destructive">*</span>
          </Label>
          <Input
            id="headline"
            value={form.headline}
            onChange={(e) => setForm((f) => ({ ...f, headline: e.target.value }))}
            maxLength={200}
            required
            placeholder="The Inquirer praises Project X"
            aria-invalid={fieldErrors['headline'] ? 'true' : 'false'}
          />
          {fieldErrors['headline'] && (
            <p className="text-xs text-destructive">{fieldErrors['headline']}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="url">
            URL <span className="text-destructive">*</span>
          </Label>
          <Input
            id="url"
            type="url"
            value={form.url}
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            required
            placeholder="https://www.inquirer.com/…"
            aria-invalid={fieldErrors['url'] ? 'true' : 'false'}
          />
          {fieldErrors['url'] && (
            <p className="text-xs text-destructive">{fieldErrors['url']}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Must be HTTPS. Each URL can only be logged once per project.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="publishedAt">
            Published <span className="text-destructive">*</span>
          </Label>
          <Input
            id="publishedAt"
            type="date"
            value={form.publishedAt}
            onChange={(e) => setForm((f) => ({ ...f, publishedAt: e.target.value }))}
            required
            max={todayIso()}
            aria-invalid={fieldErrors['publishedAt'] ? 'true' : 'false'}
          />
          {fieldErrors['publishedAt'] && (
            <p className="text-xs text-destructive">{fieldErrors['publishedAt']}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="summary">Summary</Label>
          <Textarea
            id="summary"
            value={form.summary}
            onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
            maxLength={2000}
            rows={4}
            placeholder="Optional excerpt or quote. Markdown supported."
          />
          <p className="text-xs text-muted-foreground text-right">
            {form.summary.length} / 2000
          </p>
          {fieldErrors['summary'] && (
            <p className="text-xs text-destructive">{fieldErrors['summary']}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button asChild variant="outline" type="button">
            <Link to={`/projects/${slug}`}>Cancel</Link>
          </Button>
          <Button
            type="submit"
            disabled={submitting || !form.headline.trim() || !form.url.trim()}
          >
            {submitting ? 'Logging…' : 'Log Buzz'}
          </Button>
        </div>
      </form>
    </div>
  );
}
