import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { TagChip } from '@/components/TagChip';
import { api } from '@/lib/api';

const NAMESPACES: Array<{ ns: 'topic' | 'tech' | 'event'; label: string }> = [
  { ns: 'topic', label: 'Topics' },
  { ns: 'tech', label: 'Tech' },
  { ns: 'event', label: 'Events' },
];

export function TagsOverview() {
  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Tags</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {NAMESPACES.map(({ ns, label }) => (
          <NamespaceCard key={ns} ns={ns} label={label} />
        ))}
      </div>
    </div>
  );
}

function NamespaceCard({ ns, label }: { ns: 'topic' | 'tech' | 'event'; label: string }) {
  const tagsQ = useQuery({
    queryKey: ['tags-overview', ns],
    queryFn: () => api.tags.list({ namespace: ns, perPage: 10, sort: '-projectCount' }),
  });
  const data = tagsQ.data?.data ?? [];

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-xl font-semibold mb-4">{label}</h2>
      {tagsQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tags yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {data.map((t) => (
            <TagChip
              key={t.handle}
              tag={{ namespace: t.namespace, slug: t.slug, title: t.title }}
              count={t.projectCount + t.personCount + t.helpWantedCount}
            />
          ))}
        </div>
      )}
      <Link to={`/tags/${ns}`} className="text-sm text-primary hover:underline">
        See all {label.toLowerCase()} →
      </Link>
    </section>
  );
}
