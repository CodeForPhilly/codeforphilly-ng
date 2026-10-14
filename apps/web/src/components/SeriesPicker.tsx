import { useId, useState, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import type { EventSeries } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface SeriesPickerValue {
  /** What's in the box — a series title, or the title of one to create. */
  text: string;
  /** The picked existing series, or null when none / to be created. */
  slug: string | null;
}

interface SeriesPickerProps {
  value: SeriesPickerValue;
  onChange: (next: SeriesPickerValue) => void;
  options: readonly EventSeries[];
  error?: string;
}

type Option = { kind: 'existing'; series: EventSeries } | { kind: 'create'; title: string };

/** Find an existing series whose title matches `text` (case-insensitive). */
export function matchSeries(options: readonly EventSeries[], text: string): EventSeries | undefined {
  const t = text.trim().toLowerCase();
  return t ? options.find((s) => s.title.toLowerCase() === t) : undefined;
}

/**
 * Series combobox for the event form (screens/event-edit.md): existing series
 * by title, or "Create '<typed text>'", which the form creates on save.
 */
export function SeriesPicker({ value, onChange, options, error }: SeriesPickerProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const text = value.text.trim();
  const needle = text.toLowerCase();
  const exact = matchSeries(options, text);
  const items: Option[] = [
    ...options
      .filter((s) => !needle || s.title.toLowerCase().includes(needle))
      .map((series) => ({ kind: 'existing' as const, series })),
    ...(text && !exact ? [{ kind: 'create' as const, title: text }] : []),
  ];
  const expanded = open && items.length > 0;
  const activeIndex = Math.min(active, items.length - 1);

  const choose = (opt: Option) => {
    if (opt.kind === 'existing') onChange({ text: opt.series.title, slug: opt.series.slug });
    else onChange({ text: opt.title, slug: null });
    setOpen(false);
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
      const opt = items[activeIndex];
      if (opt) choose(opt);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  const willCreate = text !== '' && !exact && value.slug === null;
  const describedBy = [willCreate ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        Series
      </label>
      <div className="relative">
        <Input
          id={inputId}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded ? `${listId}-${activeIndex}` : undefined}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          autoComplete="off"
          placeholder="None"
          maxLength={120}
          value={value.text}
          onChange={(e) => {
            const next = e.target.value;
            onChange({ text: next, slug: matchSeries(options, next)?.slug ?? null });
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {expanded && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Series"
            className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-popover py-1 text-sm shadow-md"
          >
            {items.map((opt, i) => (
              <li
                key={opt.kind === 'existing' ? opt.series.slug : '__create'}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                className={cn('cursor-pointer px-3 py-1.5', i === activeIndex && 'bg-accent text-accent-foreground')}
                // mousedown, not click, so the input's blur doesn't close the list first
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(opt);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {opt.kind === 'existing' ? opt.series.title : `Create “${opt.title}”`}
              </li>
            ))}
          </ul>
        )}
      </div>
      {willCreate && (
        <p id={helpId} className="text-xs text-muted-foreground">
          A new series “{text}” will be created when you save.
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
