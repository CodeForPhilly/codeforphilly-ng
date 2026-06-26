import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { MarkdownView } from '@/components/MarkdownView';
import { StageProgressBar, StageBadge } from '@/components/StageBadge';
import { StageInfoDialog } from '@/components/StageInfoDialog';
import { TagChip } from '@/components/TagChip';
import { PersonAvatar } from '@/components/PersonAvatar';
import { ActivityCard, mergeActivity, type ActivityItem } from '@/components/ActivityCard';
import { PostUpdateModal } from '@/components/modals/PostUpdateModal';
import { PostHelpWantedModal } from '@/components/modals/PostHelpWantedModal';
import { AddMemberModal } from '@/components/modals/AddMemberModal';
import { ManageMembersModal } from '@/components/modals/ManageMembersModal';
import { ExpressInterestModal } from '@/components/modals/ExpressInterestModal';
import { FillRoleModal } from '@/components/modals/FillRoleModal';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError, type HelpWantedRoleResponse } from '@/lib/api';
import { formatRelativeTime, formatAbsoluteDate } from '@/lib/time';

interface ProjectDetailProps {
  anchor?: 'update' | 'buzz';
}

function commitmentLabel(hours: number | null): string {
  if (hours === null) return 'Flexible commitment';
  return `~${hours} hrs/week`;
}

function isGithubUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'github.com' || u.hostname.endsWith('.github.com');
  } catch {
    return false;
  }
}

export function ProjectDetail({ anchor }: ProjectDetailProps = {}) {
  const params = useParams();
  const slug = params['slug']!;
  const number = params['number'];
  const buzzSlug = params['buzzSlug'];
  const { person } = useAuth();
  const isSignedIn = person !== null;
  const [searchParams, setSearchParams] = useSearchParams();
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [helpWantedModalOpen, setHelpWantedModalOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [manageMembersOpen, setManageMembersOpen] = useState(false);
  const [interestRole, setInterestRole] = useState<HelpWantedRoleResponse | null>(null);
  const [fillRole, setFillRole] = useState<HelpWantedRoleResponse | null>(null);
  const [stageInfoOpen, setStageInfoOpen] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);

  // Allow ?openModal=help-wanted (from /help-wanted "Post a role" picker).
  // Use the state-sync pattern so we don't trigger a cascading re-render.
  const [appliedOpenModal, setAppliedOpenModal] = useState(false);
  const openModalParam = searchParams.get('openModal');
  if (!appliedOpenModal && openModalParam === 'help-wanted') {
    setAppliedOpenModal(true);
    setHelpWantedModalOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('openModal');
    setSearchParams(next, { replace: true });
  }

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

  // #113 — Join / Leave the project. The endpoints exist; the UI was missing.
  // The project response carries no per-viewer membership flag, so membership is
  // derived from the members list + the signed-in user.
  const myMembership = person
    ? project.memberships.find((m) => m.person.slug === person.slug)
    : undefined;
  const isMember = myMembership !== undefined;
  const maintainerCount = project.memberships.filter((m) => m.isMaintainer).length;
  // A sole maintainer must transfer the role before leaving (project-detail.md authz).
  const isSoleMaintainer = (myMembership?.isMaintainer ?? false) && maintainerCount === 1;
  const canJoin = isSignedIn && !isMember;
  const canLeave = isMember && !isSoleMaintainer;

  const runMembership = async (fn: () => Promise<void>): Promise<void> => {
    setMemberBusy(true);
    setMemberError(null);
    try {
      await fn();
      await projectQ.refetch();
    } catch (err) {
      setMemberError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setMemberBusy(false);
    }
  };

  const allTags = [...project.tags.tech, ...project.tags.topic, ...project.tags.event];

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4 mb-3">
          <h1 className="text-3xl md:text-4xl font-bold">{project.title}</h1>
          <div className="flex flex-wrap gap-2 shrink-0">
            {perms.canEdit && (
              <Button asChild variant="outline">
                <Link to={`/projects/${slug}/edit`}>Edit Project</Link>
              </Button>
            )}
            {perms.canManageMembers && (
              <Button variant="outline" onClick={() => setAddMemberOpen(true)}>
                Add Member
              </Button>
            )}
            {perms.canManageMembers && (
              <Button variant="outline" onClick={() => setManageMembersOpen(true)}>
                Manage Members
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
                  <Button size="sm" onClick={() => setHelpWantedModalOpen(true)}>
                    Post new role
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
                      <div className="flex items-center justify-end gap-2">
                        {role.permissions.canFill && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setFillRole(role)}
                          >
                            Mark filled
                          </Button>
                        )}
                        {role.permissions.canClose && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (!window.confirm(`Close "${role.title}" without filling?`)) return;
                              api.helpWantedRole
                                .close(slug, role.id)
                                .then(() => helpWantedQ.refetch())
                                .catch(() => undefined);
                            }}
                          >
                            Close
                          </Button>
                        )}
                        {isSignedIn ? (
                          role.permissions.alreadyExpressedInterest ? (
                            <Button size="sm" variant="outline" disabled>
                              Interest Sent ✓
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              disabled={!role.permissions.canExpressInterest}
                              onClick={() => setInterestRole(role)}
                            >
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setUpdateModalOpen(true)}
                  >
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
          {/* Membership — #113 Join / Leave */}
          {(canJoin || isMember) && (
            <section className="space-y-2">
              {canJoin && (
                <Button
                  className="w-full"
                  disabled={memberBusy}
                  onClick={() => void runMembership(() => api.projects.join(slug))}
                >
                  {memberBusy ? 'Joining…' : 'Join Project'}
                </Button>
              )}
              {canLeave && (
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={memberBusy}
                  onClick={() => void runMembership(() => api.projects.leave(slug))}
                >
                  {memberBusy ? 'Leaving…' : 'Leave project'}
                </Button>
              )}
              {isMember && isSoleMaintainer && (
                <p className="text-xs text-muted-foreground">
                  You're the sole maintainer. Transfer the maintainer role before you can leave.
                </p>
              )}
              {memberError && (
                <p className="text-sm text-destructive" role="alert">
                  {memberError}
                </p>
              )}
            </section>
          )}

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
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Members ({project.counts.members})
                </h3>
                {perms.canManageMembers && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => setAddMemberOpen(true)}
                  >
                    + Add
                  </Button>
                )}
              </div>
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
              <Button
                variant="outline"
                onClick={() => {
                  // Copy a pre-formatted Slack message. Spec calls this
                  // out as either system-share or copy; copy works in every
                  // browser context without a Web Share API gate.
                  void navigator.clipboard.writeText(
                    `Check out ${project.title} on Code for Philly: https://codeforphilly.org/projects/${slug}`,
                  );
                }}
              >
                Share to Slack
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
            <p>
              <button
                type="button"
                onClick={() => setStageInfoOpen(true)}
                className="text-primary underline hover:no-underline"
              >
                What does this stage mean?
              </button>
            </p>
          </section>

          {/* Footer link — Edit on GitHub when developersUrl is a github.com URL */}
          {project.links.developersUrl && isGithubUrl(project.links.developersUrl) && (
            <section className="text-xs text-muted-foreground pt-2 border-t border-border">
              <a
                href={project.links.developersUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground"
              >
                Edit on GitHub →
              </a>
            </section>
          )}
        </aside>
      </div>

      <StageInfoDialog
        open={stageInfoOpen}
        onOpenChange={setStageInfoOpen}
        currentStage={project.stage}
      />

      <PostUpdateModal
        open={updateModalOpen}
        onOpenChange={setUpdateModalOpen}
        projectSlug={slug}
      />
      <PostHelpWantedModal
        open={helpWantedModalOpen}
        onOpenChange={setHelpWantedModalOpen}
        projectSlug={slug}
      />
      <AddMemberModal
        open={addMemberOpen}
        onOpenChange={setAddMemberOpen}
        projectSlug={slug}
      />
      <ManageMembersModal
        open={manageMembersOpen}
        onOpenChange={setManageMembersOpen}
        project={project}
      />
      {interestRole && (
        <ExpressInterestModal
          open={!!interestRole}
          onOpenChange={(o) => !o && setInterestRole(null)}
          projectSlug={slug}
          roleId={interestRole.id}
          roleTitle={interestRole.title}
        />
      )}
      {fillRole && (
        <FillRoleModal
          open={!!fillRole}
          onOpenChange={(o) => !o && setFillRole(null)}
          projectSlug={slug}
          roleId={fillRole.id}
          roleTitle={fillRole.title}
        />
      )}
    </div>
  );
}
