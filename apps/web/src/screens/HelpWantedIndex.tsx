import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { HelpWantedCard } from '@/components/HelpWantedCard';
import { FacetSidebar } from '@/components/FacetSidebar';
import { Pagination } from '@/components/Pagination';
import { TagChip } from '@/components/TagChip';
import { PostRolePickerModal } from '@/components/modals/PostRolePickerModal';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

const COMMITMENT_OPTIONS = [
  { value: '', label: 'Any' },
  { value: '2', label: '≤ 2 hrs/week' },
  { value: '5', label: '≤ 5 hrs/week' },
  { value: '10', label: '≤ 10 hrs/week' },
];

export function HelpWantedIndex() {
  const [params, setParams] = useSearchParams();
  const { person } = useAuth();
  const [pickerOpen, setPickerOpen] = useState(false);
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const tags = params.getAll('tag');
  const commitmentMax = params.get('commitmentMax') ?? '';

  const helpWantedQ = useQuery({
    queryKey: ['help-wanted-index', { tags, commitmentMax, page }],
    queryFn: () =>
      api.helpWanted.list({
        status: 'open',
        tag: tags.length ? tags : undefined,
        commitmentMax: commitmentMax ? parseInt(commitmentMax, 10) : undefined,
        page,
        perPage: 20,
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
      p.delete('commitmentMax');
    });
  }, [updateParams]);

  const handlePageChange = useCallback(
    (newPage: number) => {
      updateParams((p) => p.set('page', String(newPage)), false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [updateParams],
  );

  const data = helpWantedQ.data?.data ?? [];
  const meta = helpWantedQ.data?.metadata;
  const totalItems = meta?.totalItems ?? 0;
  const totalPages = meta?.totalPages ?? 1;
  const facets = meta?.facets;
  const hasActiveFilters = tags.length > 0 || commitmentMax !== '';

  return (
    <div className="container mx-auto px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          {/* The count is a sibling of the h1, not part of it: an accessible
              name that mutates on every filter change is a moving target. */}
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">Help Wanted</h1>
            <span className="inline-flex items-center rounded-full bg-muted text-muted-foreground px-2.5 py-0.5 text-sm">
              {totalItems}
            </span>
          </div>
          <p className="text-muted-foreground mt-2 max-w-3xl">
            Concrete, time-boxed ways to contribute to Code for Philly projects.
          </p>
        </div>
        {person && (
          <Button onClick={() => setPickerOpen(true)}>Post a role</Button>
        )}
      </header>
      <PostRolePickerModal open={pickerOpen} onOpenChange={setPickerOpen} />

      <div className="grid grid-cols-1 md:grid-cols-[16rem_1fr] gap-6">
        {/* The Commitment radios ride inside FacetSidebar's own labelled
            <aside> rather than a second wrapper: one `complementary`
            landmark ("Filters") holds every filter control, and nothing is
            orphaned outside it. */}
        <FacetSidebar
          facets={facets}
          activeTags={tags}
          onToggleTag={handleToggleTag}
          tabs={['tech', 'topic']}
        >
          <div className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted-foreground">
              Commitment
            </h2>
            <fieldset className="flex flex-col gap-1">
              <legend className="sr-only">Maximum commitment hours per week</legend>
              {COMMITMENT_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className={cn(
                    'flex items-center gap-2 text-sm cursor-pointer rounded px-2 py-1 hover:bg-accent',
                    commitmentMax === o.value && 'bg-accent',
                  )}
                >
                  <input
                    type="radio"
                    name="commitmentMax"
                    value={o.value}
                    checked={commitmentMax === o.value}
                    onChange={() =>
                      updateParams((p) => {
                        if (o.value) p.set('commitmentMax', o.value);
                        else p.delete('commitmentMax');
                      })
                    }
                  />
                  {o.label}
                </label>
              ))}
            </fieldset>
          </div>
        </FacetSidebar>

        <div>
          {/* HelpWantedCard renders an h3 (it also sits under section h2s on
              Home, TagDetail and Volunteer), so the results list needs its own
              h2 or the page skips h1 → h3. Visually redundant, hence sr-only. */}
          <h2 className="sr-only">Results</h2>
          <div className="flex items-center gap-2 flex-wrap text-sm mb-4">
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
                {commitmentMax && (
                  <button
                    type="button"
                    onClick={() =>
                      updateParams((p) => {
                        p.delete('commitmentMax');
                      })
                    }
                    aria-label={`Remove filter: ≤ ${commitmentMax} hrs/week`}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-accent"
                  >
                    ≤ {commitmentMax} hrs/week ×
                  </button>
                )}
                <button onClick={handleClearAll} className="text-xs text-primary hover:underline">
                  Clear filters
                </button>
              </>
            )}
          </div>

          {helpWantedQ.isLoading ? (
            <p className="text-muted-foreground py-8">Loading roles…</p>
          ) : helpWantedQ.isError ? (
            <p className="text-destructive py-8">Failed to load roles.</p>
          ) : data.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">
                No open roles match your filters.{' '}
                {hasActiveFilters && (
                  <button onClick={handleClearAll} className="text-primary hover:underline">
                    Clear filters
                  </button>
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.map((role) => (
                <HelpWantedCard key={role.id} role={role} />
              ))}
            </div>
          )}

          <Pagination page={page} totalPages={totalPages} onPageChange={handlePageChange} />
        </div>
      </div>
    </div>
  );
}
