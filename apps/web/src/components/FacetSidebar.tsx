import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TagChip } from '@/components/TagChip';
import { STAGES, type Stage } from '@/components/StageBadge';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import type { Facets, FacetEntry } from '@/lib/api';

interface FacetSidebarProps {
  facets: Facets | undefined;
  activeTags: string[];
  onToggleTag: (handle: string) => void;
  activeStages?: string[];
  onToggleStage?: (stage: string) => void;
  tabs?: Array<'topic' | 'tech' | 'event' | 'stage'>;
  limit?: number;
  className?: string;
}

const NS_LABELS = {
  topic: 'Topics',
  tech: 'Tech',
  event: 'Events',
  stage: 'Stages',
} as const;

const NS_SEE_ALL: Record<string, string> = {
  topic: '/tags/topic',
  tech: '/tags/tech',
  event: '/tags/event',
};

function facetsForNamespace(facets: Facets | undefined, ns: 'topic' | 'tech' | 'event'): FacetEntry[] {
  if (!facets) return [];
  if (ns === 'topic') return facets.byTopic ?? [];
  if (ns === 'tech') return facets.byTech ?? [];
  return facets.byEvent ?? [];
}

export function FacetSidebar({
  facets,
  activeTags,
  onToggleTag,
  activeStages,
  onToggleStage,
  tabs = ['topic', 'tech', 'event', 'stage'],
  limit = 10,
  className,
}: FacetSidebarProps) {
  const [tab, setTab] = useState<string>(tabs[0] ?? 'topic');
  const activeTagSet = new Set(activeTags);
  const activeStageSet = new Set(activeStages ?? []);

  return (
    <aside className={cn('w-full', className)} aria-label="Filters">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
          {tabs.map((t) => (
            <TabsTrigger key={t} value={t} className="text-xs">
              {NS_LABELS[t]}
            </TabsTrigger>
          ))}
        </TabsList>

        {tabs
          .filter((t): t is 'topic' | 'tech' | 'event' => t !== 'stage')
          .map((ns) => {
            const entries = facetsForNamespace(facets, ns).slice(0, limit);
            return (
              <TabsContent key={ns} value={ns} className="space-y-2 pt-3">
                {entries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No tags yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {entries.map((e) => {
                      const handle = e.handle ?? `${ns}.${e.slug ?? ''}`;
                      return (
                        <TagChip
                          key={handle}
                          tag={{
                            namespace: ns,
                            slug: e.slug ?? handle.split('.').slice(1).join('.'),
                            title: e.title ?? e.slug ?? handle,
                          }}
                          count={e.count}
                          active={activeTagSet.has(handle)}
                          onClick={() => onToggleTag(handle)}
                        />
                      );
                    })}
                  </div>
                )}
                <div className="pt-1">
                  <Link to={NS_SEE_ALL[ns] ?? '/tags'} className="text-xs text-primary hover:underline">
                    See all {NS_LABELS[ns].toLowerCase()} →
                  </Link>
                </div>
              </TabsContent>
            );
          })}

        {tabs.includes('stage') && (
          <TabsContent value="stage" className="space-y-2 pt-3">
            <div className="flex flex-col gap-1">
              {(Object.keys(STAGES) as Stage[]).map((s) => {
                const stageFacet = facets?.byStage?.find((f) => f.stage === s);
                const count = stageFacet?.count ?? 0;
                const meta = STAGES[s];
                const isActive = activeStageSet.has(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onToggleStage?.(s)}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-sm hover:bg-accent transition-colors text-left',
                      isActive && 'bg-accent ring-1 ring-primary',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className={cn('h-2 w-2 rounded-full', meta.barClassName)} />
                      {meta.label}
                    </span>
                    <span className="text-xs text-muted-foreground">{count}</span>
                  </button>
                );
              })}
            </div>
          </TabsContent>
        )}
      </Tabs>
    </aside>
  );
}
