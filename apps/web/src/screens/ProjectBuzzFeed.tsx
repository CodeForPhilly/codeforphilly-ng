import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityCard } from '@/components/ActivityCard';
import { Pagination } from '@/components/Pagination';
import { TagChip } from '@/components/TagChip';
import { api } from '@/lib/api';

export function ProjectBuzzFeed() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const tags = params.getAll('tag');

  const feedQ = useQuery({
    queryKey: ['project-buzz-feed', { tags, page }],
    queryFn: () =>
      api.projectBuzz.feed({
        tag: tags.length ? tags : undefined,
        page,
        perPage: 30,
      }),
  });

  const data = feedQ.data?.data ?? [];
  const meta = feedQ.data?.metadata;
  const totalPages = meta?.totalPages ?? 1;
  const hasFilters = tags.length > 0;

  const updateParams = useCallback(
    (mutate: (p: URLSearchParams) => void, resetPage = true) => {
      const next = new URLSearchParams(params);
      mutate(next);
      if (resetPage) next.delete('page');
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">In the press</h1>
        <p className="text-muted-foreground mt-2">
          Articles, mentions, and external posts about Code for Philly projects.
        </p>
        {hasFilters && (
          <div className="flex items-center gap-2 mt-3 flex-wrap text-sm">
            <span className="text-muted-foreground">Filters:</span>
            {tags.map((handle) => {
              const [ns, ...slugParts] = handle.split('.');
              const slug = slugParts.join('.');
              return (
                <TagChip
                  key={handle}
                  tag={{ namespace: ns ?? 'topic', slug, title: slug }}
                  onClick={() =>
                    updateParams((p) => {
                      const cur = p.getAll('tag').filter((c) => c !== handle);
                      p.delete('tag');
                      for (const c of cur) p.append('tag', c);
                    })
                  }
                  showNamespace
                />
              );
            })}
            <button
              onClick={() => updateParams((p) => p.delete('tag'))}
              className="text-xs text-primary hover:underline"
            >
              Clear all
            </button>
          </div>
        )}
      </header>

      {feedQ.isLoading ? (
        <p className="text-muted-foreground py-8">Loading buzz…</p>
      ) : data.length === 0 ? (
        <p className="text-muted-foreground py-8">
          {hasFilters ? 'No buzz matches your filter.' : 'No buzz logged yet.'}
        </p>
      ) : (
        <div className="space-y-4">
          {data.map((buzz) => (
            <ActivityCard key={buzz.id} item={{ kind: 'buzz', data: buzz }} />
          ))}
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        onPageChange={(p) => {
          updateParams((u) => u.set('page', String(p)), false);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />
    </div>
  );
}
