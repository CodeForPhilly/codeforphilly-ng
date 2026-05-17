import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { TagResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

type Namespace = 'topic' | 'tech' | 'event';

interface TagPickerProps {
  namespace: Namespace;
  label?: string;
  value: string[];
  onChange: (slugs: string[]) => void;
  /** Allow creating new tags inline (staff only per project-edit spec). */
  allowCreate?: boolean;
  description?: string;
}

/** Tag picker — autocompletes against the existing tag space for `namespace`. */
export function TagPicker({
  namespace,
  label,
  value,
  onChange,
  allowCreate,
  description,
}: TagPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const tagsQ = useQuery({
    queryKey: ['tag-picker', namespace],
    queryFn: () => api.tags.list({ namespace, perPage: 100 }),
  });

  const allTags = useMemo(() => tagsQ.data?.data ?? [], [tagsQ.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allTags.filter((t) => !value.includes(t.slug)).slice(0, 12);
    return allTags
      .filter(
        (t) =>
          !value.includes(t.slug) &&
          (t.slug.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)),
      )
      .slice(0, 12);
  }, [allTags, query, value]);

  const exactMatch = filtered.find(
    (t) => t.slug.toLowerCase() === query.trim().toLowerCase(),
  );

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const addTag = (slug: string) => {
    if (!value.includes(slug)) onChange([...value, slug]);
    setQuery('');
    setOpen(false);
  };

  const removeTag = (slug: string) => {
    onChange(value.filter((s) => s !== slug));
  };

  const findTitle = (slug: string): string => {
    const found = allTags.find((t) => t.slug === slug);
    return found?.title ?? slug;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = query.trim().toLowerCase();
      if (!q) return;
      if (exactMatch) {
        addTag(exactMatch.slug);
      } else if (filtered[0]) {
        addTag(filtered[0].slug);
      } else if (allowCreate && /^[a-z0-9][a-z0-9-]{0,49}$/.test(q)) {
        addTag(q);
      }
    } else if (e.key === 'Backspace' && !query && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="space-y-1.5" ref={containerRef}>
      {label && <Label className="text-sm font-medium">{label}</Label>}
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {value.map((slug) => (
          <span
            key={slug}
            className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs"
          >
            {findTitle(slug)}
            <button
              type="button"
              onClick={() => removeTag(slug)}
              aria-label={`Remove ${slug}`}
              className="hover:text-primary/70"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={
            allowCreate
              ? `Add ${namespace} tag — type to search or create…`
              : `Add ${namespace} tag — type to search…`
          }
        />
        {open && (filtered.length > 0 || (allowCreate && query.trim())) && (
          <ul
            role="listbox"
            className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded-md border border-border bg-popover shadow-md"
          >
            {filtered.map((t: TagResponse) => (
              <li key={t.slug}>
                <button
                  type="button"
                  onClick={() => addTag(t.slug)}
                  className={cn(
                    'w-full text-left px-3 py-1.5 text-sm hover:bg-accent',
                  )}
                >
                  {t.title}{' '}
                  <span className="text-xs text-muted-foreground">
                    ({t.slug} · {t.projectCount} projects)
                  </span>
                </button>
              </li>
            ))}
            {allowCreate &&
              query.trim() &&
              !exactMatch &&
              /^[a-z0-9][a-z0-9-]{0,49}$/.test(query.trim().toLowerCase()) && (
                <li>
                  <button
                    type="button"
                    onClick={() => addTag(query.trim().toLowerCase())}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent text-primary"
                  >
                    Create new tag “{query.trim().toLowerCase()}”
                  </button>
                </li>
              )}
          </ul>
        )}
      </div>
    </div>
  );
}
