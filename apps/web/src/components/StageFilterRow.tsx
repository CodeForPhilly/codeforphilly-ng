/**
 * Horizontal pill row of project stages, rendered above the search +
 * results column on the projects index. Stages are a 7-value fixed
 * enum and benefit from being visible at a glance rather than tucked
 * inside the tag sidebar's tab strip. See
 * specs/screens/projects-index.md → "Stage row (top, above results)".
 */
import { STAGES, type Stage } from '@/components/StageBadge';
import { cn } from '@/lib/utils';
import type { Facets, FacetEntry } from '@/lib/api';

interface StageFilterRowProps {
  facets: Facets | undefined;
  activeStages: string[];
  onToggleStage: (stage: string) => void;
  className?: string;
}

function findStageFacet(facets: Facets | undefined, stage: string): FacetEntry | undefined {
  return facets?.byStage?.find((f) => f.stage === stage);
}

export function StageFilterRow({
  facets,
  activeStages,
  onToggleStage,
  className,
}: StageFilterRowProps) {
  const activeSet = new Set(activeStages);

  return (
    <div
      role="group"
      aria-label="Stage filter"
      className={cn('flex flex-wrap items-center gap-2', className)}
    >
      {(Object.keys(STAGES) as Stage[]).map((s) => {
        const facet = findStageFacet(facets, s);
        const count = facet?.count ?? 0;
        const meta = STAGES[s];
        const isActive = activeSet.has(s);
        return (
          <button
            key={s}
            type="button"
            onClick={() => onToggleStage(s)}
            aria-pressed={isActive}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              isActive
                ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary/40'
                : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', meta.barClassName)} aria-hidden="true" />
            {meta.label}
            {count > 0 && <span className="opacity-70">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
