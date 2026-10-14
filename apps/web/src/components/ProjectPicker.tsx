import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface ProjectChoice {
  readonly slug: string;
  readonly title: string;
}

export interface ProjectSuggestionGroup {
  readonly label: string;
  readonly items: readonly ProjectChoice[];
}

interface ProjectPickerProps {
  /** Shown when the box is opened with nothing typed — e.g. the viewer's recent projects, then teams other attendees named. */
  groups: readonly ProjectSuggestionGroup[];
  onPick: (project: ProjectChoice) => void;
  disabled?: boolean;
  placeholder?: string;
  'aria-label'?: string;
}

const MAX_RESULTS = 8;
const DEBOUNCE_MS = 200;

/** `value`, settled for `ms` after its last change. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Find-as-you-type project combobox (screens/event-detail.md → follow-up).
 * Never lists the catalog: opened empty it shows the suggestion `groups`
 * (empty groups omitted); once text is typed it searches
 * `GET /api/projects?q=` (last word as a prefix) and lists at most eight
 * results in relevance order.
 */
export function ProjectPicker({
  groups,
  onPick,
  disabled,
  placeholder = 'Type a project name',
  'aria-label': ariaLabel = 'Pick a project',
}: ProjectPickerProps) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const needle = text.trim();
  const q = useDebounced(needle, DEBOUNCE_MS);
  const searchQ = useQuery({
    queryKey: ['projects', { q, perPage: MAX_RESULTS }],
    queryFn: () => api.projects.list({ q, perPage: MAX_RESULTS }),
    enabled: q.length > 0,
    staleTime: 60_000,
  });

  const searching = needle.length > 0;
  const shown: readonly ProjectSuggestionGroup[] = searching
    ? [{ label: '', items: (searchQ.data?.data ?? []).slice(0, MAX_RESULTS) }]
    : groups.filter((g) => g.items.length > 0).map((g) => ({ label: g.label, items: g.items.slice(0, MAX_RESULTS) }));
  // One flat list for keyboard navigation across groups.
  const items: readonly ProjectChoice[] = shown.flatMap((g) => g.items);
  const waiting = searching && (q !== needle || searchQ.isLoading);
  // Nothing typed and nothing to suggest: the input's placeholder is the
  // whole hint; an empty popover would only repeat it.
  const expanded = open && (searching || items.length > 0);
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));

  const choose = (p: ProjectChoice) => {
    setText(p.title);
    setOpen(false);
    onPick(p);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && expanded) {
      e.preventDefault();
      const p = items[activeIndex];
      if (p) choose(p);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  let status: string | null = null;
  if (searching && waiting) status = 'Searching…';
  else if (searching && items.length === 0) status = 'No projects match';

  let index = -1;
  return (
    <div className="relative w-full max-w-xs">
      <Input
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && items.length > 0 ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        autoFocus
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {expanded && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-popover py-1 text-sm shadow-md">
          {status ? (
            <p className="px-3 py-1.5 text-muted-foreground" role="status">
              {status}
            </p>
          ) : (
            <ul id={listId} role="listbox" aria-label={ariaLabel} className="max-h-72 overflow-auto">
              {shown.map((group) => (
                <li key={group.label} role="presentation">
                  {group.label && (
                    <p className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.label}</p>
                  )}
                  <ul role="group" aria-label={group.label || undefined}>
                    {group.items.map((p) => {
                      const i = ++index;
                      return (
                        <li
                          key={p.slug}
                          id={`${listId}-${i}`}
                          role="option"
                          aria-selected={i === activeIndex}
                          className={cn('cursor-pointer px-3 py-1.5', i === activeIndex && 'bg-accent text-accent-foreground')}
                          // mousedown, not click, so the input's blur doesn't close the list first
                          onMouseDown={(e) => {
                            e.preventDefault();
                            choose(p);
                          }}
                          onMouseEnter={() => setActive(i)}
                        >
                          {p.title}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
