import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProjectCard } from '@/components/ProjectCard';
import { FacetSidebar } from '@/components/FacetSidebar';
import { Pagination } from '@/components/Pagination';
import { TagChip } from '@/components/TagChip';
import { STAGES, type Stage } from '@/components/StageBadge';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';

const SORT_OPTIONS = [
  { value: '-updatedAt', label: 'Recently updated' },
  { value: '-createdAt', label: 'Recently created' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'stage', label: 'Stage' },
];

export function ProjectsIndex() {
  const { person } = useAuth();
  const [params, setParams] = useSearchParams();
  const isStaff = person?.accountLevel === 'staff' || person?.accountLevel === 'administrator';

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? '-updatedAt';
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const tags = params.getAll('tag');
  const stages = (params.get('stage') ?? '').split(',').filter(Boolean);
  const helpWanted = params.get('helpWanted') === 'true';
  const includeDeleted = isStaff && params.get('includeDeleted') === 'true';

  const [searchInput, setSearchInput] = useState(q);
  const [lastQ, setLastQ] = useState(q);
  if (q !== lastQ) {
    setLastQ(q);
    setSearchInput(q);
  }

  const projectsQ = useQuery({
    queryKey: ['projects', { q, tags, stages, sort, page, helpWanted, includeDeleted }],
    queryFn: () =>
      api.projects.list({
        q: q || undefined,
        tag: tags.length ? tags : undefined,
        stageIn: stages.length ? stages.join(',') : undefined,
        sort,
        page,
        perPage: 30,
        helpWanted: helpWanted || undefined,
        includeDeleted: includeDeleted || undefined,
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

  // Debounced search
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

  const handleToggleStage = useCallback(
    (stage: string) => {
      updateParams((p) => {
        const cur = (p.get('stage') ?? '').split(',').filter(Boolean);
        const next = cur.includes(stage) ? cur.filter((s) => s !== stage) : [...cur, stage];
        if (next.length) p.set('stage', next.join(','));
        else p.delete('stage');
      });
    },
    [updateParams],
  );

  const handleClearAll = useCallback(() => {
    updateParams((p) => {
      p.delete('tag');
      p.delete('stage');
      p.delete('q');
      p.delete('helpWanted');
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

  const data = projectsQ.data?.data ?? [];
  const meta = projectsQ.data?.metadata;
  const totalItems = meta?.totalItems ?? 0;
  const totalPages = meta?.totalPages ?? 1;
  const facets = meta?.facets;
  const hasActiveFilters = tags.length > 0 || stages.length > 0 || q.length > 0 || helpWanted;

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            Civic Projects Directory
            <span className="inline-flex items-center rounded-full bg-muted text-muted-foreground px-2.5 py-0.5 text-sm">
              {totalItems}
            </span>
          </h1>
        </div>
        {person && (
          <Button asChild>
            <Link to="/projects/create">Add Project</Link>
          </Button>
        )}
      </div>
      <p className="text-muted-foreground mb-6 max-w-3xl">
        Browse civic technology projects from the Code for Philly community. Each project welcomes contributors at all levels.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[16rem_1fr] gap-6">
        {/* Sidebar */}
        <FacetSidebar
          facets={facets}
          activeTags={tags}
          activeStages={stages}
          onToggleTag={handleToggleTag}
          onToggleStage={handleToggleStage}
        />

        {/* Main */}
        <div>
          {/* Search box */}
          <Input
            type="search"
            placeholder="Search projects…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="mb-4"
            aria-label="Search projects"
          />

          {/* Active filters + sort */}
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
                        className="cursor-pointer"
                        showNamespace
                      />
                    );
                  })}
                  {stages.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => handleToggleStage(s)}
                      className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-accent"
                    >
                      Stage: {STAGES[s as Stage]?.label ?? s} ×
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={handleClearAll}
                    className="text-xs text-primary hover:underline"
                  >
                    Clear all
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {isStaff && (
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={includeDeleted}
                    onChange={(e) =>
                      updateParams((p) => {
                        if (e.target.checked) p.set('includeDeleted', 'true');
                        else p.delete('includeDeleted');
                      })
                    }
                  />
                  Include deleted
                </label>
              )}
              <select
                value={sort}
                onChange={(e) =>
                  updateParams((p) => {
                    if (e.target.value === '-updatedAt') p.delete('sort');
                    else p.set('sort', e.target.value);
                  })
                }
                className="text-sm border border-border rounded px-2 py-1 bg-background"
                aria-label="Sort projects"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Results */}
          {projectsQ.isLoading ? (
            <p className="text-muted-foreground py-8">Loading projects…</p>
          ) : projectsQ.isError ? (
            <p className="text-destructive py-8">Failed to load projects.</p>
          ) : data.length === 0 ? (
            <div className="py-12 text-center">
              {hasActiveFilters ? (
                <p className="text-muted-foreground">
                  No projects match your filters.{' '}
                  <button onClick={handleClearAll} className="text-primary hover:underline">
                    Clear all
                  </button>
                </p>
              ) : (
                <p className="text-muted-foreground">No projects yet — be the first to add one!</p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {data.map((p) => (
                <ProjectCard key={p.slug} project={p} />
              ))}
            </div>
          )}

          <Pagination page={page} totalPages={totalPages} onPageChange={handlePageChange} />
        </div>
      </div>
    </div>
  );
}
