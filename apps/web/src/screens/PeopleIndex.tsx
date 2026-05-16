import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { PersonCard } from '@/components/PersonCard';
import { FacetSidebar } from '@/components/FacetSidebar';
import { Pagination } from '@/components/Pagination';
import { TagChip } from '@/components/TagChip';
import { api } from '@/lib/api';

const SORT_OPTIONS = [
  { value: '-createdAt', label: 'Recently joined' },
  { value: 'fullName', label: 'Name A–Z' },
];

export function PeopleIndex() {
  const [params, setParams] = useSearchParams();

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? '-createdAt';
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const tags = params.getAll('tag');

  const [searchInput, setSearchInput] = useState(q);
  const [lastQ, setLastQ] = useState(q);
  if (q !== lastQ) {
    setLastQ(q);
    setSearchInput(q);
  }

  const peopleQ = useQuery({
    queryKey: ['people', { q, tags, sort, page }],
    queryFn: () =>
      api.people.list({
        q: q || undefined,
        tag: tags.length ? tags : undefined,
        sort,
        page,
        perPage: 24,
      }),
  });

  const updateParams = useCallback(
    (mutate: (p: URLSearchParams) => void, resetPage = true) => {
      const next = new URLSearchParams(params);
      mutate(next);
      if (resetPage) next.delete('page');
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  useEffect(() => {
    if (searchInput === q) return;
    const t = setTimeout(() => {
      updateParams((p) => {
        if (searchInput) p.set('q', searchInput);
        else p.delete('q');
      });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, q, updateParams]);

  const handleToggleTag = useCallback(
    (handle: string) => {
      updateParams((p) => {
        const current = p.getAll('tag');
        p.delete('tag');
        if (current.includes(handle)) {
          for (const c of current) if (c !== handle) p.append('tag', c);
        } else {
          for (const c of current) p.append('tag', c);
          p.append('tag', handle);
        }
      });
    },
    [updateParams],
  );

  const handleClearAll = useCallback(() => {
    updateParams((p) => {
      p.delete('tag');
      p.delete('q');
    });
    setSearchInput('');
  }, [updateParams]);

  const handlePageChange = useCallback(
    (newPage: number) => {
      updateParams((p) => p.set('page', String(newPage)), false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [updateParams],
  );

  const data = peopleQ.data?.data ?? [];
  const meta = peopleQ.data?.metadata;
  const totalItems = meta?.totalItems ?? 0;
  const totalPages = meta?.totalPages ?? 1;
  const facets = meta?.facets;
  const hasActiveFilters = tags.length > 0 || q.length > 0;

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h1 className="text-3xl font-bold flex items-center gap-3">
          Members
          <span className="inline-flex items-center rounded-full bg-muted text-muted-foreground px-2.5 py-0.5 text-sm">
            {totalItems}
          </span>
        </h1>
      </div>

      <Input
        type="search"
        placeholder="Search members…"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        className="mb-4 max-w-md"
        aria-label="Search members"
      />

      <div className="grid grid-cols-1 md:grid-cols-[16rem_1fr] gap-6">
        <FacetSidebar
          facets={facets}
          activeTags={tags}
          onToggleTag={handleToggleTag}
          tabs={['topic', 'tech']}
        />

        <div>
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div className="flex items-center gap-2 flex-wrap text-sm">
              {hasActiveFilters && (
                <>
                  <span className="text-muted-foreground">Filters:</span>
                  {tags.map((handle) => {
                    const [ns, ...slugParts] = handle.split('.');
                    const slug = slugParts.join('.');
                    return (
                      <TagChip
                        key={handle}
                        tag={{ namespace: ns ?? 'topic', slug, title: slug }}
                        onClick={() => handleToggleTag(handle)}
                        showNamespace
                      />
                    );
                  })}
                  <button onClick={handleClearAll} className="text-xs text-primary hover:underline">
                    Clear
                  </button>
                </>
              )}
            </div>
            <select
              value={sort}
              onChange={(e) =>
                updateParams((p) => {
                  if (e.target.value === '-createdAt') p.delete('sort');
                  else p.set('sort', e.target.value);
                })
              }
              className="text-sm border border-border rounded px-2 py-1 bg-background"
              aria-label="Sort members"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {peopleQ.isLoading ? (
            <p className="text-muted-foreground py-8">Loading members…</p>
          ) : peopleQ.isError ? (
            <p className="text-destructive py-8">Failed to load members.</p>
          ) : data.length === 0 ? (
            <p className="text-muted-foreground py-12 text-center">
              {hasActiveFilters
                ? 'No members match your filters.'
                : 'No members yet.'}
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {data.map((p) => (
                <PersonCard key={p.slug} person={p} />
              ))}
            </div>
          )}

          <Pagination page={page} totalPages={totalPages} onPageChange={handlePageChange} />
        </div>
      </div>
    </div>
  );
}
