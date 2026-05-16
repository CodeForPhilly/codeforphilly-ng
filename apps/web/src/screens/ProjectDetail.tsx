import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { MarkdownView } from '@/components/MarkdownView';
import { StageProgressBar, StageBadge } from '@/components/StageBadge';
import { TagChip } from '@/components/TagChip';
import { PersonAvatar } from '@/components/PersonAvatar';
import { ActivityCard, mergeActivity, type ActivityItem } from '@/components/ActivityCard';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError } from '@/lib/api';
import { formatRelativeTime, formatAbsoluteDate } from '@/lib/time';

interface ProjectDetailProps {
  anchor?: 'update' | 'buzz';
}

function commitmentLabel(hours: number | null): string {
  if (hours === null) return 'Flexible commitment';
  return `~${hours} hrs/week`;
}

export function ProjectDetail({ anchor }: ProjectDetailProps = {}) {
  const params = useParams();
  const slug = params['slug']!;
  const number = params['number'];
  const buzzSlug = params['buzzSlug'];
  const { person } = useAuth();
  const isSignedIn = person !== null;

  const projectQ = useQuery({
    queryKey: ['project', slug],
    queryFn: () => api.projects.get(slug),
  });
  const updatesQ = useQuery({
    queryKey: ['project-updates', slug, { perPage: 20 }],
    queryFn: () => api.projects.updates(slug, { perPage: 20 }),
  });
  const buzzQ = useQuery({
    queryKey: ['project-buzz', slug, { perPage: 20 }],
    queryFn: () => api.projects.buzz(slug, { perPage: 20 }),
  });
  const helpWantedQ = useQuery({
    queryKey: ['project-help-wanted', slug, { status: 'open' }],
    queryFn: () => api.projects.helpWanted(slug, { status: 'open' }),
  });

  // Scroll-to-anchor for update/buzz permalinks
  useEffect(() => {
    if (!anchor) return;
    const id = anchor === 'update' && number ? `update-${number}` : anchor === 'buzz' && buzzSlug ? `buzz-${buzzSlug}` : null;
    if (!id) return;
    const t = setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 200);
    return () => clearTimeout(t);
  }, [anchor, number, buzzSlug]);

  const activity: ActivityItem[] = useMemo(
    () => mergeActivity(updatesQ.data?.data ?? [], buzzQ.data?.data ?? []),
    [updatesQ.data, buzzQ.data],
  );

  if (projectQ.isLoading) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading project…</div>;
  }

  if (projectQ.isError) {
    const err = projectQ.error;
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="container mx-auto px-4 py-16 text-center">
          <h1 className="text-2xl font-bold mb-2">Project not found</h1>
          <p className="text-muted-foreground mb-6">No project with the slug “{slug}” exists.</p>
          <Link to="/projects" className="text-primary hover:underline">
            ← Browse all projects
          </Link>
        </div>
      );
    }
    return <div className="container mx-auto px-4 py-12 text-destructive">Failed to load project.</div>;
  }

  const project = projectQ.data!.data;
  const helpWantedRoles = helpWantedQ.data?.data ?? [];
  const perms = project.permissions;

  const allTags = [...project.tags.tech, ...project.tags.topic, ...project.tags.event];

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4 mb-3">
          <h1 className="text-3xl md:text-4xl font-bold">{project.title}</h1>
          <div className="flex gap-2 shrink-0">
            {perms.canEdit && (
              <Button asChild variant="outline">
                <Link to={`/projects/${slug}/edit`}>Edit Project</Link>
              </Button>
            )}
            {!isSignedIn && (
              <Button asChild variant="outline">
                <Link to={`/login?return=${encodeURIComponent(`/projects/${slug}`)}`}>
                  Sign in to contribute
                </Link>
              </Button>
            )}
          </div>
        </div>
        <StageProgressBar stage={project.stage} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-8">
          {project.overviewHtml && (
            <section>
              <h2 className="text-xl font-semibold mb-3">Overview</h2>
              <MarkdownView html={project.overviewHtml} />
            </section>
          )}

          {(helpWantedRoles.length > 0 || perms.canPostHelpWanted) && (
            <section id="help-wanted">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">Help Wanted</h2>
                {perms.canPostHelpWanted && (
                  <Button asChild size="sm">
                    <Link to={`/projects/${slug}/help-wanted/new`}>Post new role</Link>
                  </Button>
                )}
              </div>
              {helpWantedRoles.length === 0 ? (
                <p className="text-muted-foreground text-sm">No open roles right now.</p>
              ) : (
                <div className="space-y-3">
                  {helpWantedRoles.map((role) => (
                    <article key={role.id} className="rounded-lg border border-border bg-card p-4">
                      <h3 className="font-semibold mb-2">{role.title}</h3>
                      <div className="line-clamp-4 mb-3 text-sm">
                        <MarkdownView html={role.descriptionHtml} />
                      </div>
                      <div className="flex flex-wrap gap-2 mb-3">
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs">
                          {commitmentLabel(role.commitmentHoursPerWeek)}
                        </span>
                        {role.tags.tech.map((t) => <TagChip key={`tech.${t.slug}`} tag={t} />)}
                        {role.tags.topic.map((t) => <TagChip key={`topic.${t.slug}`} tag={t} />)}
                      </div>
                      <div className="flex justify-end">
                        {isSignedIn ? (
                          role.permissions.alreadyExpressedInterest ? (
                            <Button size="sm" variant="outline" disabled>
                              Interest Sent ✓
                            </Button>
                          ) : (
                            <Button size="sm" disabled={!role.permissions.canExpressInterest}>
                              Express Interest
                            </Button>
                          )
                        ) : (
                          <Link
                            to={`/login?return=${encodeURIComponent(`/projects/${slug}`)}`}
                            className="text-sm text-primary hover:underline"
                          >
                            Sign in to express interest
                          </Link>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">Project Activity</h2>
              <div className="flex gap-2">
                {perms.canPostUpdate && (
                  <Button size="sm" variant="outline" disabled>
                    Post Update
                  </Button>
                )}
                {isSignedIn && (
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/projects/${slug}/buzz/new`}>Log Buzz</Link>
                  </Button>
                )}
              </div>
            </div>

            {updatesQ.isLoading || buzzQ.isLoading ? (
              <p className="text-muted-foreground">Loading activity…</p>
            ) : activity.length === 0 ? (
              <p className="text-muted-foreground">
                This project doesn't have any activity yet, post an update or log some buzz!
              </p>
            ) : (
              <div className="space-y-3">
                {activity.map((item) => {
                  const id =
                    item.kind === 'update'
                      ? `update-${item.data.number}`
                      : `buzz-${item.data.slug}`;
                  return (
                    <div key={`${item.kind}-${item.data.id}`} id={id}>
                      <ActivityCard item={item} />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* Sidebar */}
        <aside className="space-y-6">
          {/* Project info */}
          <section>
            <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
              Project Info
            </h3>
            <div className="flex flex-col gap-2">
              {project.links.usersUrl && (
                <Button asChild>
                  <a href={project.links.usersUrl} target="_blank" rel="noopener noreferrer">
                    Users' Site
                  </a>
                </Button>
              )}
              {project.links.developersUrl && (
                <Button asChild variant="outline">
                  <a href={project.links.developersUrl} target="_blank" rel="noopener noreferrer">
                    Developers' Site
                  </a>
                </Button>
              )}
              {project.links.chatChannel && (
                <Button asChild variant="outline">
                  <Link to={`/chat?channel=${encodeURIComponent(project.links.chatChannel)}`}>
                    Chat Channel
                  </Link>
                </Button>
              )}
            </div>
          </section>

          {/* Members */}
          {project.memberships.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
                Members ({project.counts.members})
              </h3>
              <div className="flex flex-wrap gap-2">
                {project.memberships.map((m) => (
                  <PersonAvatar
                    key={m.id}
                    person={m.person}
                    size={m.isMaintainer ? 56 : 40}
                    title={`${m.person.fullName}${m.role ? ` · ${m.role}` : ''}${m.isMaintainer ? ' · Maintainer' : ''}`}
                    className={m.isMaintainer ? 'ring-2 ring-primary' : ''}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Tags */}
          {allTags.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
                Tags
              </h3>
              <div className="space-y-2">
                {project.tags.tech.length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">Tech: </span>
                    <span className="inline-flex flex-wrap gap-1">
                      {project.tags.tech.map((t) => (
                        <TagChip key={`tech.${t.slug}`} tag={t} />
                      ))}
                    </span>
                  </div>
                )}
                {project.tags.topic.length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">Topics: </span>
                    <span className="inline-flex flex-wrap gap-1">
                      {project.tags.topic.map((t) => (
                        <TagChip key={`topic.${t.slug}`} tag={t} />
                      ))}
                    </span>
                  </div>
                )}
                {project.tags.event.length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">Events: </span>
                    <span className="inline-flex flex-wrap gap-1">
                      {project.tags.event.map((t) => (
                        <TagChip key={`event.${t.slug}`} tag={t} />
                      ))}
                    </span>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Share */}
          <section>
            <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
              Share
            </h3>
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(`https://codeforphilly.org/projects/${slug}`);
                }}
              >
                Copy link
              </Button>
            </div>
          </section>

          {/* Info */}
          <section className="text-sm text-muted-foreground space-y-1">
            <p>
              <span className="font-medium text-foreground">Created:</span>{' '}
              <span title={formatAbsoluteDate(project.createdAt)}>
                {formatRelativeTime(project.createdAt)}
              </span>
            </p>
            <p>
              <span className="font-medium text-foreground">Last updated:</span>{' '}
              <span title={formatAbsoluteDate(project.updatedAt)}>
                {formatRelativeTime(project.updatedAt)}
              </span>
            </p>
            <p className="flex items-center gap-2">
              <span className="font-medium text-foreground">Stage:</span>
              <StageBadge stage={project.stage} />
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
