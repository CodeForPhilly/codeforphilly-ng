import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Input } from '@/components/ui/input';
import { useSearch, type SearchResult } from '@/hooks/useSearch';
import { cn } from '@/lib/utils';

interface SearchBoxProps {
  /** If true, renders compactly for embedding in the mobile sheet */
  inline?: boolean;
}

const GROUP_LABELS: Record<SearchResult['type'], string> = {
  project: 'Projects',
  member: 'Members',
  tag: 'Tags',
};

function groupResults(results: SearchResult[]): Array<{ type: SearchResult['type']; items: SearchResult[] }> {
  const groups: Record<SearchResult['type'], SearchResult[]> = { project: [], member: [], tag: [] };
  for (const r of results) groups[r.type].push(r);
  return (['project', 'member', 'tag'] as const)
    .filter((t) => groups[t].length > 0)
    .map((t) => ({ type: t, items: groups[t] }));
}

/**
 * Site search — an ARIA APG combobox with a listbox popup.
 *
 * Focus never leaves the `role="combobox"` input; the active option is pointed
 * at with `aria-activedescendant` instead of being focused. The popup swallows
 * `mousedown`, so a pointer click on an option cannot blur the input — which is
 * why there is no close-on-blur timeout here (the old 150ms one raced the click
 * and made results unreachable).
 *
 * Options stay `<a href>` — `option` is an allowed role for `a[href]`, and the
 * href keeps middle-click / "open in new tab" working. Plain clicks and Enter
 * are intercepted and routed through `useNavigate()` so activation stays inside
 * the SPA instead of triggering a full-page reload.
 */
export function SearchBox({ inline = false }: SearchBoxProps) {
  const navigate = useNavigate();
  const { query, results, loading, setQuery, clear } = useSearch();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-option-${i}`;
  const groupHeaderId = (type: string) => `${baseId}-group-${type}`;

  const trimmed = query.trim();
  const showDropdown = open && trimmed.length > 0;

  const grouped = useMemo(() => groupResults(results), [results]);
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);
  const seeAllUrl = trimmed ? `/projects?q=${encodeURIComponent(trimmed)}` : null;
  const optionUrls = useMemo(
    () => [...flat.map((r) => r.url), ...(seeAllUrl ? [seeAllUrl] : [])],
    [flat, seeAllUrl],
  );

  // Clamp instead of resetting from an effect: results land asynchronously and
  // can shrink out from under the cursor mid-keystroke.
  const activeIdx = activeIndex >= 0 && activeIndex < optionUrls.length ? activeIndex : -1;
  const activeDescendant = showDropdown && activeIdx >= 0 ? optionId(activeIdx) : undefined;

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const activate = useCallback(
    (url: string) => {
      void navigate(url);
      clear();
      close();
      // Selection is done: hand focus back to the page rather than leaving it
      // parked in a now-empty combobox.
      inputRef.current?.blur();
    },
    [navigate, clear, close],
  );

  const handleFocus = useCallback(() => {
    setOpen(true);
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
      setOpen(true);
      setActiveIndex(-1);
    },
    [setQuery],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const len = optionUrls.length;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
        if (len > 0) setActiveIndex(activeIdx === -1 ? 0 : (activeIdx + 1) % len);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
        if (len > 0) setActiveIndex(activeIdx <= 0 ? len - 1 : activeIdx - 1);
        return;
      }
      if (e.key === 'Enter') {
        const target = showDropdown && activeIdx >= 0 ? optionUrls[activeIdx] : undefined;
        if (target) {
          e.preventDefault();
          activate(target);
        } else if (seeAllUrl) {
          activate(seeAllUrl);
        }
        return;
      }
      if (e.key === 'Escape') {
        clear();
        close();
        inputRef.current?.blur();
      }
    },
    [optionUrls, activeIdx, showDropdown, seeAllUrl, activate, clear, close],
  );

  /** Let the browser handle modified clicks (new tab / new window) natively. */
  const handleOptionClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, url: string) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      activate(url);
    },
    [activate],
  );

  const optionClass = (i: number) =>
    cn(
      'block px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground',
      i === activeIdx && 'bg-accent text-accent-foreground',
    );

  return (
    <div
      className={`relative ${inline ? 'w-full' : 'w-24 lg:w-48 lg:focus-within:w-72 transition-all duration-200'}`}
    >
      <Input
        ref={inputRef}
        type="search"
        role="combobox"
        placeholder="Search projects, members, tags..."
        value={query}
        autoComplete="off"
        aria-label="Search the site"
        aria-expanded={showDropdown}
        aria-controls={showDropdown ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendant}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={close}
        onKeyDown={handleKeyDown}
        className="h-8 text-sm"
      />

      {showDropdown && (
        <div
          data-search-dropdown
          // Swallowing mousedown keeps focus on the input, so onBlur can close
          // the popup immediately without racing the option's click.
          onMouseDown={(e) => e.preventDefault()}
          // Inline (mobile sheet): stay in the document flow so the popup
          // cannot hang below a short viewport; the sheet's flex column and
          // the popup's own scroll keep it reachable. Otherwise float right.
          className={cn(
            'bg-popover border border-border rounded-md shadow-lg py-1 overflow-y-auto',
            inline
              ? 'mt-1 max-h-64'
              : 'absolute top-full right-0 min-w-72 mt-1 z-50 max-h-[28rem]',
          )}
        >
          {/* Status lives outside the listbox — a listbox may only own
              options, groups and presentational content. */}
          <div role="status" className="empty:hidden">
            {loading && results.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
            )}
            {!loading && results.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                No results for &ldquo;{query}&rdquo;
              </p>
            )}
          </div>

          <div id={listboxId} role="listbox" aria-label="Search results">
            {grouped.map((group, gi) => {
              const offset = grouped
                .slice(0, gi)
                .reduce((n, g) => n + g.items.length, 0);
              return (
                <div
                  key={group.type}
                  role="group"
                  aria-labelledby={groupHeaderId(group.type)}
                >
                  <div
                    id={groupHeaderId(group.type)}
                    role="presentation"
                    className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                  >
                    {GROUP_LABELS[group.type]}
                  </div>
                  {group.items.map((r, j) => {
                    const i = offset + j;
                    return (
                      <a
                        key={`${r.type}-${r.slug}`}
                        id={optionId(i)}
                        href={r.url}
                        role="option"
                        aria-selected={i === activeIdx}
                        tabIndex={-1}
                        className={optionClass(i)}
                        onMouseMove={() => {
                          if (i !== activeIdx) setActiveIndex(i);
                        }}
                        onClick={(e) => handleOptionClick(e, r.url)}
                      >
                        {r.title}
                      </a>
                    );
                  })}
                </div>
              );
            })}

            {seeAllUrl && (
              <a
                id={optionId(flat.length)}
                href={seeAllUrl}
                role="option"
                aria-selected={flat.length === activeIdx}
                tabIndex={-1}
                className={cn(
                  'block px-3 py-2 text-sm border-t border-border hover:bg-accent hover:text-accent-foreground text-primary',
                  flat.length === activeIdx && 'bg-accent text-accent-foreground',
                )}
                onMouseMove={() => {
                  if (flat.length !== activeIdx) setActiveIndex(flat.length);
                }}
                onClick={(e) => handleOptionClick(e, seeAllUrl)}
              >
                See all results for &ldquo;{query}&rdquo;
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
