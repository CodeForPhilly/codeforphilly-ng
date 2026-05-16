import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Input } from '@/components/ui/input';
import { useSearch, type SearchResult } from '@/hooks/useSearch';

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

export function SearchBox({ inline = false }: SearchBoxProps) {
  const navigate = useNavigate();
  const { query, results, loading, setQuery, clear } = useSearch();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFocus = useCallback(() => {
    setOpen(true);
  }, []);

  const handleBlur = useCallback(() => {
    setTimeout(() => setOpen(false), 150);
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
      setOpen(true);
    },
    [setQuery],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && query.trim()) {
        void navigate(`/projects?q=${encodeURIComponent(query.trim())}`);
        clear();
        setOpen(false);
        inputRef.current?.blur();
      }
      if (e.key === 'Escape') {
        clear();
        setOpen(false);
        inputRef.current?.blur();
      }
    },
    [navigate, query, clear],
  );

  const showDropdown = open && query.trim().length > 0;
  const grouped = groupResults(results);

  return (
    <div
      className={`relative ${inline ? 'w-full' : 'w-48 focus-within:w-72 transition-all duration-200'}`}
    >
      <Input
        ref={inputRef}
        type="search"
        placeholder="Search projects, members, tags..."
        value={query}
        aria-label="Search the site"
        aria-expanded={showDropdown}
        aria-controls="search-results-dropdown"
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className="h-8 text-sm"
      />

      {showDropdown && (
        <div
          id="search-results-dropdown"
          role="listbox"
          aria-label="Search results"
          className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-lg z-50 py-1 max-h-[28rem] overflow-y-auto"
        >
          {loading && results.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
          )}
          {!loading && results.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              No results for &ldquo;{query}&rdquo;
            </p>
          )}

          {grouped.map((group) => (
            <div key={group.type}>
              <div className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {GROUP_LABELS[group.type]}
              </div>
              {group.items.map((r) => (
                <a
                  key={`${r.type}-${r.slug}`}
                  href={r.url}
                  role="option"
                  aria-selected={false}
                  className="block px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    clear();
                    setOpen(false);
                  }}
                >
                  {r.title}
                </a>
              ))}
            </div>
          ))}

          {query.trim() && (
            <a
              href={`/projects?q=${encodeURIComponent(query.trim())}`}
              className="block px-3 py-2 text-sm border-t border-border hover:bg-accent hover:text-accent-foreground text-primary"
              onClick={() => {
                clear();
                setOpen(false);
              }}
            >
              See all results for &ldquo;{query}&rdquo;
            </a>
          )}
        </div>
      )}
    </div>
  );
}
