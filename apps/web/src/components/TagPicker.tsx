import { useEffect, useId, useMemo, useRef, useState } from 'react';
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

const CREATABLE_SLUG = /^[a-z0-9][a-z0-9-]{0,49}$/;

/**
 * Tag picker — autocompletes against the existing tag space for `namespace`.
 *
 * An ARIA APG combobox: focus stays on the `role="combobox"` input and the
 * active `role="option"` is pointed at with `aria-activedescendant`, so the
 * list is operable from the keyboard (arrows wrap, Enter selects, Escape
 * closes) as `specs/behaviors/app-shell.md` requires of every dropdown.
 */
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
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

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

  const trimmedQuery = query.trim().toLowerCase();
  const exactMatch = filtered.find((t) => t.slug.toLowerCase() === trimmedQuery);
  const canCreate = Boolean(
    allowCreate && trimmedQuery && !exactMatch && CREATABLE_SLUG.test(trimmedQuery),
  );

  const optionCount = filtered.length + (canCreate ? 1 : 0);
  const showList = open && optionCount > 0;
  // Clamp instead of resetting from an effect — the tag list loads async and
  // filtering can shrink the option set out from under the cursor.
  const activeIdx = activeIndex >= 0 && activeIndex < optionCount ? activeIndex : -1;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const addTag = (slug: string) => {
    if (!value.includes(slug)) onChange([...value, slug]);
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
  };

  const removeTag = (slug: string) => {
    onChange(value.filter((s) => s !== slug));
  };

  const findTitle = (slug: string): string => {
    const found = allTags.find((t) => t.slug === slug);
    return found?.title ?? slug;
  };

  /** Activate the option at `i`: an existing tag, or the trailing create entry. */
  const selectOption = (i: number) => {
    const tag = filtered[i];
    if (tag) {
      addTag(tag.slug);
    } else if (canCreate && i === filtered.length) {
      addTag(trimmedQuery);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      if (optionCount > 0) {
        setActiveIndex(activeIdx === -1 ? 0 : (activeIdx + 1) % optionCount);
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (optionCount > 0) {
        setActiveIndex(activeIdx <= 0 ? optionCount - 1 : activeIdx - 1);
      }
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showList && activeIdx >= 0) {
        selectOption(activeIdx);
        return;
      }
      // No active option — fall back to the historical
      // exact-match → first-match → create chain.
      if (!trimmedQuery) return;
      if (exactMatch) {
        addTag(exactMatch.slug);
      } else if (filtered[0]) {
        addTag(filtered[0].slug);
      } else if (allowCreate && CREATABLE_SLUG.test(trimmedQuery)) {
        addTag(trimmedQuery);
      }
      return;
    }
    if (e.key === 'Backspace' && !query && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const optionClass = (i: number) =>
    cn(
      'cursor-pointer px-3 py-1.5 text-sm hover:bg-accent',
      i === activeIdx && 'bg-accent',
    );

  return (
    <div className="space-y-1.5" ref={containerRef}>
      {label && (
        <Label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </Label>
      )}
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
          id={inputId}
          role="combobox"
          value={query}
          autoComplete="off"
          aria-expanded={showList}
          aria-controls={showList ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            showList && activeIdx >= 0 ? optionId(activeIdx) : undefined
          }
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={
            allowCreate
              ? `Add ${namespace} tag — type to search or create…`
              : `Add ${namespace} tag — type to search…`
          }
        />
        {showList && (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label ?? `${namespace} tags`}
            // Keep focus on the input when an option is clicked.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded-md border border-border bg-popover shadow-md"
          >
            {filtered.map((t: TagResponse, i) => (
              <li
                key={t.slug}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIdx}
                onClick={() => selectOption(i)}
                onMouseEnter={() => setActiveIndex(i)}
                className={optionClass(i)}
              >
                {t.title}{' '}
                <span className="text-xs text-muted-foreground">
                  ({t.slug} · {t.projectCount} projects)
                </span>
              </li>
            ))}
            {canCreate && (
              <li
                id={optionId(filtered.length)}
                role="option"
                aria-selected={filtered.length === activeIdx}
                onClick={() => selectOption(filtered.length)}
                onMouseEnter={() => setActiveIndex(filtered.length)}
                className={cn(optionClass(filtered.length), 'text-primary')}
              >
                Create new tag “{trimmedQuery}”
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
