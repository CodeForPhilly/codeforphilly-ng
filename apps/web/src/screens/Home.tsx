import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { ActivityCard, mergeActivity, type ActivityItem } from '@/components/ActivityCard';
import { HelpWantedCard } from '@/components/HelpWantedCard';
import { HeroSlideshow } from '@/components/HeroSlideshow';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

function FeaturedTile({ title, summary, slug, imageUrl }: { title: string; summary: string | null; slug: string; imageUrl?: string | null }) {
  return (
    <Link
      to={`/projects/${slug}`}
      className="group flex flex-col rounded-lg overflow-hidden border border-border bg-card hover:shadow-lg transition-shadow"
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="w-full h-44 object-cover" loading="lazy" />
      ) : (
        <div className="w-full h-44 bg-gradient-to-br from-primary/10 to-primary/30" />
      )}
      <div className="p-4">
        <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors">
          {title}
        </h3>
        {summary && (
          <p className="text-sm text-muted-foreground mt-1 line-clamp-3">{summary}</p>
        )}
      </div>
    </Link>
  );
}

const ACTIVITY_FILTERS = ['all', 'updates', 'buzz'] as const;
type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export function Home() {
  const { person } = useAuth();
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');

  const featuredQ = useQuery({
    queryKey: ['projects', { featured: true, perPage: 8 }],
    queryFn: () => api.projects.list({ featured: true, perPage: 8 }),
  });

  const totalCountQ = useQuery({
    queryKey: ['projects', { perPage: 1, count: true }],
    queryFn: () => api.projects.list({ perPage: 1 }),
  });

  const updatesQ = useQuery({
    queryKey: ['project-updates', { perPage: 10 }],
    queryFn: () => api.projectUpdates.feed({ perPage: 10 }),
  });

  const buzzQ = useQuery({
    queryKey: ['project-buzz', { perPage: 10 }],
    queryFn: () => api.projectBuzz.feed({ perPage: 10 }),
  });

  const helpWantedQ = useQuery({
    queryKey: ['help-wanted', { perPage: 4, sort: '-createdAt' }],
    queryFn: () => api.helpWanted.list({ perPage: 4, sort: '-createdAt' }),
  });

  const activity: ActivityItem[] = useMemo(() => {
    const merged = mergeActivity(updatesQ.data?.data ?? [], buzzQ.data?.data ?? [], 10);
    if (activityFilter === 'all') return merged;
    if (activityFilter === 'updates') return merged.filter((i) => i.kind === 'update');
    return merged.filter((i) => i.kind === 'buzz');
  }, [updatesQ.data, buzzQ.data, activityFilter]);

  const totalProjects = totalCountQ.data?.metadata.totalItems ?? null;

  return (
    <div>
      {/* Hero */}
      <section className="relative border-b border-border bg-neutral-900 overflow-hidden">
        <HeroSlideshow className="absolute inset-0" />
        <div
          className="absolute inset-0 bg-gradient-to-br from-black/55 via-black/30 to-black/55 pointer-events-none"
          aria-hidden="true"
        />
        <div className="relative container mx-auto px-4 py-20 text-center">
          <h1 className="text-3xl md:text-5xl font-bold text-white mb-4 max-w-3xl mx-auto leading-tight drop-shadow-md">
            Contribute towards technology-related projects that benefit the City of Philadelphia.
          </h1>
          <p className="text-lg md:text-xl text-white/85 mb-8 drop-shadow">
            No coding experience required.
          </p>
          <Button asChild size="lg" className="bg-green-600 hover:bg-green-700 text-white shadow-lg">
            <Link to={person ? '/projects' : '/volunteer'}>
              {person ? 'Browse Projects' : 'Volunteer'}
            </Link>
          </Button>
        </div>
      </section>

      {/* Featured projects */}
      <section className="container mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-6">Join a Project</h2>
        {featuredQ.isLoading ? (
          <p className="text-muted-foreground">Loading featured projects…</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {(featuredQ.data?.data ?? []).map((p) => (
              <FeaturedTile
                key={p.slug}
                title={p.title}
                summary={p.summary || p.overviewExcerpt}
                slug={p.slug}
                imageUrl={p.featuredImageUrl ?? null}
              />
            ))}
          </div>
        )}
        <div className="mt-6 text-right">
          <Link to="/projects" className="text-primary hover:underline">
            See all {totalProjects ?? ''} projects →
          </Link>
        </div>
      </section>

      {/* Get involved */}
      <section className="bg-muted/30 border-y border-border">
        <div className="container mx-auto px-4 py-12">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link to="/sponsor" className="block rounded-lg border border-border bg-card p-6 hover:shadow-md transition-shadow">
              <h3 className="text-lg font-semibold mb-1">Sponsor</h3>
              <p className="text-sm text-muted-foreground">Sponsor an event</p>
            </Link>
            <Link
              to={person ? '/projects/create' : '/login?return=/projects/create'}
              className="block rounded-lg border border-border bg-card p-6 hover:shadow-md transition-shadow"
            >
              <h3 className="text-lg font-semibold mb-1">Start a Project</h3>
              <p className="text-sm text-muted-foreground">Start or get help on a project</p>
            </Link>
            <Link to="/volunteer" className="block rounded-lg border border-border bg-card p-6 hover:shadow-md transition-shadow">
              <h3 className="text-lg font-semibold mb-1">Volunteer</h3>
              <p className="text-sm text-muted-foreground">Join our projects</p>
            </Link>
          </div>
        </div>
      </section>

      {/* Activity + Help-wanted rail */}
      <section className="container mx-auto px-4 py-12 grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold">Latest Project Activity</h2>
            <div className="flex gap-1" role="group" aria-label="Filter activity">
              {ACTIVITY_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setActivityFilter(f)}
                  className={cn(
                    'text-xs font-medium px-3 py-1 rounded-full border transition-colors capitalize',
                    activityFilter === f
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-border hover:bg-accent',
                  )}
                >
                  {f === 'all' ? 'All' : f}
                </button>
              ))}
            </div>
          </div>

          {updatesQ.isLoading || buzzQ.isLoading ? (
            <p className="text-muted-foreground">Loading activity…</p>
          ) : activity.length === 0 ? (
            <p className="text-muted-foreground">No project activity yet on the site.</p>
          ) : (
            <div className="space-y-4">
              {activity.map((item) => (
                <ActivityCard key={`${item.kind}-${item.data.id}`} item={item} />
              ))}
            </div>
          )}

          <div className="mt-6">
            <Link to="/project-updates" className="text-primary hover:underline">
              View all activity →
            </Link>
          </div>
        </div>

        <aside className="lg:col-span-1">
          <h2 className="text-xl font-bold mb-4">Help Wanted</h2>
          {helpWantedQ.isLoading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (helpWantedQ.data?.data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No open roles right now.</p>
          ) : (
            <div className="space-y-3">
              {(helpWantedQ.data?.data ?? []).map((role) => (
                <HelpWantedCard key={role.id} role={role} />
              ))}
            </div>
          )}
          <div className="mt-4">
            <Link to="/help-wanted" className="text-primary hover:underline text-sm">
              Browse all open roles →
            </Link>
          </div>
        </aside>
      </section>
    </div>
  );
}
