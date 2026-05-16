import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { TagChip } from '@/components/TagChip';
import { Pagination } from '@/components/Pagination';
import { api } from '@/lib/api';

const NS_LABELS: Record<string, string> = {
  topic: 'Topics',
  tech: 'Tech',
  event: 'Events',
};

const SORT_OPTIONS = [
  { value: '-projectCount', label: 'Most projects' },
  { value: '-personCount', label: 'Most people' },
  { value: 'title', label: 'A–Z' },
];

export function TagsNamespace() {
  const params = useParams();
  const namespace = params['namespace']!;
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const sort = searchParams.get('sort') ?? '-projectCount';
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const [searchInput, setSearchInput] = useState(q);
  const [lastQ, setLastQ] = useState(q);
  if (q !== lastQ) {
    setLastQ(q);
    setSearchInput(q);
  }

  const updateParams = useCallback(
    (mutate: (p: URLSearchParams) => void, resetPage = true) => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      if (resetPage) next.delete('page');
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
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

  const validNamespace = namespace in NS_LABELS;

  const tagsQ = useQuery({
    queryKey: ['tags-namespace', namespace, { q, sort, page }],
    queryFn: () =>
      api.tags.list({
        namespace,
        q: q || undefined,
        sort,
        page,
        perPage: 60,
      }),
    enabled: validNamespace,
  });

  if (!validNamespace) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-3">Unknown namespace</h1>
        <Link to="/tags" className="text-primary hover:underline">
          ← Browse all tags
        </Link>
      </div>
    );
  }

  const data = tagsQ.data?.data ?? [];
  const meta = tagsQ.data?.metadata;
  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-2">{NS_LABELS[namespace]}</h1>
      <Link to="/tags" className="text-sm text-primary hover:underline">
        ← All namespaces
      </Link>

      <div className="flex flex-col sm:flex-row gap-3 mt-6 mb-6">
        <Input
          type="search"
          placeholder={`Search ${NS_LABELS[namespace]?.toLowerCase()}…`}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="max-w-md"
          aria-label="Search tags"
        />
        <select
          value={sort}
          onChange={(e) =>
            updateParams((p) => {
              if (e.target.value === '-projectCount') p.delete('sort');
              else p.set('sort', e.target.value);
            })
          }
          className="text-sm border border-border rounded px-2 py-1 bg-background"
          aria-label="Sort tags"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {tagsQ.isLoading ? (
        <p className="text-muted-foreground py-8">Loading…</p>
      ) : data.length === 0 ? (
        <p className="text-muted-foreground py-8">No tags found.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {data.map((t) => (
            <TagChip
              key={t.handle}
              tag={{ namespace: t.namespace, slug: t.slug, title: t.title }}
              count={t.projectCount + t.personCount + t.helpWantedCount}
            />
          ))}
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        onPageChange={(p) => updateParams((u) => u.set('page', String(p)), false)}
      />
    </div>
  );
}
