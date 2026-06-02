import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TagChip } from '@/components/TagChip';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import type { Facets, FacetEntry } from '@/lib/api';

interface FacetSidebarProps {
  facets: Facets | undefined;
  activeTags: string[];
  onToggleTag: (handle: string) => void;
  tabs?: Array<'topic' | 'tech' | 'event'>;
  limit?: number;
  className?: string;
}

const NS_LABELS = {
  topic: 'Topics',
  tech: 'Tech',
  event: 'Events',
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
  tabs = ['topic', 'tech', 'event'],
  limit = 10,
  className,
}: FacetSidebarProps) {
  const [tab, setTab] = useState<string>(tabs[0] ?? 'topic');
  const activeTagSet = new Set(activeTags);

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

        {tabs.map((ns) => {
          // Pin active selections to the top of their namespace's list.
          // The API already pins them into the facet response when they
          // fall below top 10, so we just stable-sort active-first here.
          const entries = facetsForNamespace(facets, ns).slice(0, limit + 5);
          const sorted = [...entries].sort((a, b) => {
            const aActive = a.tag ? activeTagSet.has(a.tag) : false;
            const bActive = b.tag ? activeTagSet.has(b.tag) : false;
            if (aActive !== bActive) return aActive ? -1 : 1;
            return 0;
          });
          return (
            <TabsContent key={ns} value={ns} className="space-y-2 pt-3">
              {sorted.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tags yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {sorted.map((e) => {
                    // The API emits `tag` in `<namespace>.<slug>` form. Skip
                    // entries without it (defensive — should never happen).
                    if (!e.tag) return null;
                    const dot = e.tag.indexOf('.');
                    const slug = dot >= 0 ? e.tag.slice(dot + 1) : e.tag;
                    return (
                      <TagChip
                        key={e.tag}
                        tag={{
                          namespace: ns,
                          slug,
                          title: e.title ?? slug,
                        }}
                        count={e.count}
                        active={activeTagSet.has(e.tag)}
                        onClick={() => onToggleTag(e.tag!)}
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
      </Tabs>
    </aside>
  );
}
