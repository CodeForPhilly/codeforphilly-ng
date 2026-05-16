import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Input } from '@/components/ui/input';
import { useSearch } from '@/hooks/useSearch';

interface SearchBoxProps {
  /** If true, renders compactly for embedding in the mobile sheet */
  inline?: boolean;
}

export function SearchBox({ inline = false }: SearchBoxProps) {
  const navigate = useNavigate();
  const { query, results, setQuery, clear } = useSearch();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFocus = useCallback(() => {
    setOpen(true);
  }, []);

  const handleBlur = useCallback(() => {
    // Delay so clicks on results fire first
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
        void navigate(`/search?q=${encodeURIComponent(query.trim())}`);
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
          className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-lg z-50 py-1"
        >
          {results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              No results for &ldquo;{query}&rdquo;
            </p>
          ) : (
            results.map((r) => (
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
                <span className="text-muted-foreground text-xs mr-2 capitalize">
                  {r.type}
                </span>
                {r.title}
              </a>
            ))
          )}

          {query.trim() && (
            <a
              href={`/search?q=${encodeURIComponent(query.trim())}`}
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
