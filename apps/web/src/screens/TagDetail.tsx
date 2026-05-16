import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ProjectCard } from '@/components/ProjectCard';
import { PersonCard } from '@/components/PersonCard';
import { HelpWantedCard } from '@/components/HelpWantedCard';
import { api, ApiError } from '@/lib/api';

const VALID_NAMESPACES = new Set(['topic', 'tech', 'event']);

export function TagDetail() {
  const params = useParams();
  const namespace = params['namespace']!;
  const slug = params['slug']!;
  const handle = `${namespace}.${slug}`;

  const valid = VALID_NAMESPACES.has(namespace);

  const tagQ = useQuery({
    queryKey: ['tag', handle],
    queryFn: () => api.tags.get(handle),
    enabled: valid,
  });

  const projectsQ = useQuery({
    queryKey: ['tag-projects', handle],
    queryFn: () => api.projects.list({ tag: [handle], perPage: 12 }),
    enabled: valid,
  });

  const peopleQ = useQuery({
    queryKey: ['tag-people', handle],
    queryFn: () => api.people.list({ tag: [handle], perPage: 12 }),
    enabled: valid && namespace !== 'event',
  });

  const helpWantedQ = useQuery({
    queryKey: ['tag-help-wanted', handle],
    queryFn: () => api.helpWanted.list({ tag: [handle], perPage: 6, status: 'open' }),
    enabled: valid,
  });

  if (!valid) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-3">Tag not found</h1>
        <Link to="/tags" className="text-primary hover:underline">
          Browse all tags →
        </Link>
      </div>
    );
  }

  if (tagQ.isLoading) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading tag…</div>;
  }

  if (tagQ.isError) {
    const err = tagQ.error;
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="container mx-auto px-4 py-16 text-center">
          <h1 className="text-2xl font-bold mb-3">Tag not found</h1>
          <Link to="/tags" className="text-primary hover:underline">
            Browse all tags →
          </Link>
        </div>
      );
    }
    return <div className="container mx-auto px-4 py-12 text-destructive">Failed to load tag.</div>;
  }

  const tag = tagQ.data!.data;

  return (
    <div className="container mx-auto px-4 py-8 space-y-10">
      <header>
        <h1 className="text-3xl font-bold">{tag.title}</h1>
        <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs mt-2 capitalize">
          {tag.namespace}
        </span>
      </header>

      {/* Projects */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">
            Projects{tag.projectCount > 0 ? ` (${tag.projectCount})` : ''}
          </h2>
          {tag.projectCount > 12 && (
            <Link
              to={`/projects?tag=${encodeURIComponent(handle)}`}
              className="text-sm text-primary hover:underline"
            >
              See all {tag.projectCount} projects →
            </Link>
          )}
        </div>
        {projectsQ.isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (projectsQ.data?.data ?? []).length === 0 ? (
          <p className="text-muted-foreground text-sm">No projects with this tag yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(projectsQ.data?.data ?? []).map((p) => (
              <ProjectCard key={p.slug} project={p} />
            ))}
          </div>
        )}
      </section>

      {/* Help-wanted */}
      {(helpWantedQ.data?.data ?? []).length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Help wanted</h2>
            <Link
              to={`/help-wanted?tag=${encodeURIComponent(handle)}`}
              className="text-sm text-primary hover:underline"
            >
              See all →
            </Link>
          </div>
          <div className="space-y-3">
            {(helpWantedQ.data?.data ?? []).map((r) => (
              <HelpWantedCard key={r.id} role={r} />
            ))}
          </div>
        </section>
      )}

      {/* Members */}
      {namespace !== 'event' && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">
              Members{tag.personCount > 0 ? ` (${tag.personCount})` : ''}
            </h2>
            {tag.personCount > 12 && (
              <Link
                to={`/members?tag=${encodeURIComponent(handle)}`}
                className="text-sm text-primary hover:underline"
              >
                See all {tag.personCount} members →
              </Link>
            )}
          </div>
          {peopleQ.isLoading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (peopleQ.data?.data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No members with this tag yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {(peopleQ.data?.data ?? []).map((p) => (
                <PersonCard key={p.slug} person={p} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
