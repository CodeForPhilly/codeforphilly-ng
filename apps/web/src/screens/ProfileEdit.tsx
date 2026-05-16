import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MarkdownEditor } from '@/components/MarkdownEditor';
import { TagPicker } from '@/components/TagPicker';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError, type UpdatePersonInput } from '@/lib/api';
import { slugify } from '@/lib/slug';

interface FormState {
  fullName: string;
  firstName: string;
  lastName: string;
  bio: string;
  slug: string;
  email: string;
  slackHandle: string;
  tagsTopic: string[];
  tagsTech: string[];
}

export function ProfileEdit() {
  const params = useParams();
  const slug = params['slug']!;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { person: me, loading: authLoading } = useAuth();
  const isStaff =
    me?.accountLevel === 'staff' || me?.accountLevel === 'administrator';

  const personQ = useQuery({
    queryKey: ['person', slug],
    queryFn: () => api.people.get(slug),
  });

  const [form, setForm] = useState<FormState>({
    fullName: '',
    firstName: '',
    lastName: '',
    bio: '',
    slug: '',
    email: '',
    slackHandle: '',
    tagsTopic: [],
    tagsTech: [],
  });
  const [hydratedFromSlug, setHydratedFromSlug] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [avatarUploading, setAvatarUploading] = useState(false);

  // Hydrate from server data via state-sync (avoids cascading rerenders).
  if (personQ.data && hydratedFromSlug !== personQ.data.data.slug) {
    const p = personQ.data.data;
    setHydratedFromSlug(p.slug);
    setForm({
      fullName: p.fullName,
      firstName: p.firstName ?? '',
      lastName: p.lastName ?? '',
      bio: p.bio ?? '',
      slug: p.slug,
      email: '',
      slackHandle: '',
      tagsTopic: p.tags.topic.map((t) => t.slug),
      tagsTech: p.tags.tech.map((t) => t.slug),
    });
  }

  if (authLoading || personQ.isLoading) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading…</div>;
  }

  if (!me) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-3">Sign in required</h1>
        <Button asChild>
          <Link to={`/login?return=${encodeURIComponent(`/members/${slug}/edit`)}`}>Sign in</Link>
        </Button>
      </div>
    );
  }

  if (personQ.isError || !personQ.data) {
    return <div className="container mx-auto px-4 py-12 text-destructive">Failed to load profile.</div>;
  }

  const person = personQ.data.data;

  if (!person.permissions.canEdit) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-3">Not authorized</h1>
        <Button asChild variant="outline">
          <Link to={`/members/${slug}`}>Back to profile</Link>
        </Button>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFieldErrors({});
    const payload: UpdatePersonInput = {
      fullName: form.fullName.trim(),
      firstName: form.firstName.trim() || null,
      lastName: form.lastName.trim() || null,
      bio: form.bio.trim() || null,
      tags: {
        topic: form.tagsTopic,
        tech: form.tagsTech,
      },
    };
    if (isStaff && form.slug !== person.slug) payload.slug = form.slug;
    if (form.slackHandle.trim()) payload.slackHandle = form.slackHandle.trim();

    try {
      const res = await api.people.update(slug, payload);
      await queryClient.invalidateQueries({ queryKey: ['person', slug] });
      toast.success('Profile saved');
      void navigate(`/members/${res.data.slug}`);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setFieldErrors(err.fields);
        toast.error(err.message);
      } else {
        toast.error("Couldn't save profile.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await fetch(`/api/people/${encodeURIComponent(slug)}/avatar`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'Avatar upload failed');
      }
      await queryClient.invalidateQueries({ queryKey: ['person', slug] });
      toast.success('Avatar updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Avatar upload failed');
    } finally {
      setAvatarUploading(false);
      e.target.value = '';
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Edit Profile</h1>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate(`/members/${slug}`)}
          >
            Cancel
          </Button>
          <Button type="submit" form="profile-form" disabled={submitting || !form.fullName.trim()}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </header>

      <form id="profile-form" onSubmit={handleSubmit} className="space-y-5">
        <div>
          <Label className="block mb-2">Avatar</Label>
          <div className="flex items-center gap-3">
            {person.avatarUrl ? (
              <img
                src={person.avatarUrl}
                alt=""
                className="h-16 w-16 rounded-lg object-cover"
              />
            ) : (
              <div className="h-16 w-16 rounded-lg bg-muted flex items-center justify-center text-2xl text-muted-foreground">
                {person.fullName.slice(0, 1)}
              </div>
            )}
            <label className="text-sm">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleAvatarUpload}
                disabled={avatarUploading}
                className="block"
              />
              {avatarUploading && (
                <span className="block mt-1 text-xs text-muted-foreground">Uploading…</span>
              )}
            </label>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="fullName">
            Full name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="fullName"
            value={form.fullName}
            onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
            required
          />
          {fieldErrors['fullName'] && (
            <p className="text-xs text-destructive">{fieldErrors['fullName']}</p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="firstName">First name</Label>
            <Input
              id="firstName"
              value={form.firstName}
              onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lastName">Last name</Label>
            <Input
              id="lastName"
              value={form.lastName}
              onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
            />
          </div>
        </div>

        <MarkdownEditor
          label="Bio"
          description="Tell people what you work on and what you're interested in."
          value={form.bio}
          onChange={(v) => setForm((f) => ({ ...f, bio: v }))}
          error={fieldErrors['bio']}
        />

        {isStaff && (
          <div className="space-y-1.5">
            <Label htmlFor="slug">Slug (staff only)</Label>
            <Input
              id="slug"
              value={form.slug}
              onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))}
              pattern="^[a-z0-9][a-z0-9-_]{1,79}$"
            />
            <p className="text-xs text-muted-foreground">URL: /members/{form.slug}</p>
            {fieldErrors['slug'] && (
              <p className="text-xs text-destructive">{fieldErrors['slug']}</p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="slackHandle">Slack handle</Label>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">@</span>
            <Input
              id="slackHandle"
              value={form.slackHandle}
              onChange={(e) => setForm((f) => ({ ...f, slackHandle: e.target.value }))}
              placeholder="janedoe"
            />
          </div>
        </div>

        <TagPicker
          namespace="topic"
          label="Topic interests"
          value={form.tagsTopic}
          onChange={(v) => setForm((f) => ({ ...f, tagsTopic: v }))}
          allowCreate={isStaff}
        />
        <TagPicker
          namespace="tech"
          label="Tech I work in"
          value={form.tagsTech}
          onChange={(v) => setForm((f) => ({ ...f, tagsTech: v }))}
          allowCreate={isStaff}
        />
      </form>
    </div>
  );
}
