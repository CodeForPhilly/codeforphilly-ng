import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { MarkdownView } from '@/components/MarkdownView';
import { StageBadge } from '@/components/StageBadge';
import { TagChip } from '@/components/TagChip';
import { PersonAvatar } from '@/components/PersonAvatar';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError } from '@/lib/api';
import { formatMonthYear, formatRelativeTime } from '@/lib/time';

export function PersonDetail() {
  const params = useParams();
  const slug = params['slug']!;
  const { person: viewer } = useAuth();

  const personQ = useQuery({
    queryKey: ['person', slug],
    queryFn: () => api.people.get(slug),
  });

  if (personQ.isLoading) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading member…</div>;
  }

  if (personQ.isError) {
    const err = personQ.error;
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="container mx-auto px-4 py-16 text-center">
          <h1 className="text-2xl font-bold mb-2">Member not found</h1>
          <Link to="/members" className="text-primary hover:underline">
            ← Browse all members
          </Link>
        </div>
      );
    }
    return <div className="container mx-auto px-4 py-12 text-destructive">Failed to load member.</div>;
  }

  const person = personQ.data!.data;
  const isSelf = viewer !== null && viewer.slug === person.slug;
  const allTags = [...person.tags.tech, ...person.tags.topic];

  // Memberships sorted: maintainer desc, joinedAt desc
  const memberships = [...person.memberships].sort((a, b) => {
    if (a.isMaintainer !== b.isMaintainer) return a.isMaintainer ? -1 : 1;
    return b.joinedAt.localeCompare(a.joinedAt);
  });

  return (
    <div className="container mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2 space-y-8">
        <header className="flex items-start gap-6">
          <PersonAvatar
            person={{ slug: person.slug, fullName: person.fullName, avatarUrl: person.avatarUrl }}
            size={120}
            asLink={false}
            className="rounded-lg"
          />
          <div className="flex-1">
            <h1 className="text-3xl font-bold mb-1">{person.fullName}</h1>
            <p className="text-sm text-muted-foreground mb-3">
              Member since {formatMonthYear(person.createdAt)}
            </p>
            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {allTags.map((t) => (
                  <TagChip key={`${t.namespace}.${t.slug}`} tag={t} showNamespace />
                ))}
              </div>
            )}
          </div>
          {person.permissions.canEdit && (
            <Button asChild variant="outline">
              <Link to={`/members/${person.slug}/edit`}>Edit profile</Link>
            </Button>
          )}
        </header>

        {person.bioHtml && (
          <section>
            <h2 className="text-xl font-semibold mb-3">About</h2>
            <MarkdownView html={person.bioHtml} />
          </section>
        )}

        <section>
          <h2 className="text-xl font-semibold mb-3">
            Projects ({memberships.length})
          </h2>
          {memberships.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Not a member of any projects yet.{' '}
              <Link to="/projects" className="text-primary hover:underline">
                Browse projects →
              </Link>
            </p>
          ) : (
            <ul className="space-y-2">
              {memberships.map((m, idx) => (
                <li
                  key={`${m.project.slug}-${idx}`}
                  className="flex items-center justify-between gap-3 rounded border border-border bg-card p-3"
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <Link
                      to={`/projects/${m.project.slug}`}
                      className="font-medium hover:text-primary"
                    >
                      {m.project.title}
                    </Link>
                    <StageBadge stage={m.project.stage} />
                    {m.role && (
                      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs">
                        {m.role}
                      </span>
                    )}
                    {m.isMaintainer && (
                      <span className="inline-flex items-center rounded-full bg-primary/15 text-primary px-2 py-0.5 text-xs">
                        Maintainer
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    joined {formatRelativeTime(m.joinedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {person.recentUpdates.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-3">Recent updates</h2>
            <div className="space-y-3">
              {person.recentUpdates.map((u) => (
                <article key={u.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between mb-1 text-sm">
                    <Link
                      to={`/projects/${u.project.slug}/updates/${u.number}`}
                      className="font-medium hover:text-primary"
                    >
                      {u.project.title} · Update #{u.number}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(u.createdAt)}
                    </span>
                  </div>
                  <div className="line-clamp-3 text-sm">
                    <MarkdownView html={u.bodyHtml} />
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>

      <aside className="space-y-4 text-sm">
        {(person.slackHandle || person.email) && (
          <section>
            <h3 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wide">
              Contact
            </h3>
            <ul className="space-y-1">
              {person.slackHandle && (
                <li>
                  <a
                    href={`https://codeforphilly.slack.com/team/${encodeURIComponent(person.slackHandle)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline hover:no-underline"
                  >
                    DM on Slack
                  </a>
                </li>
              )}
              {person.email && (
                <li>
                  <a
                    href={`mailto:${person.email}`}
                    className="text-primary underline hover:no-underline"
                  >
                    {person.email}
                  </a>
                </li>
              )}
            </ul>
          </section>
        )}
        <section>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wide">
            Member since
          </h3>
          <p>{formatMonthYear(person.createdAt)}</p>
        </section>
        {isSelf && (
          <section>
            <Link to="/account" className="text-primary underline hover:no-underline">
              Manage account
            </Link>
          </section>
        )}
      </aside>
    </div>
  );
}
