import { useCallback, useEffect, useRef, useState } from 'react';

export interface SearchResult {
  type: 'project' | 'member' | 'tag';
  slug: string;
  title: string;
  url: string;
}

export interface SearchState {
  query: string;
  results: SearchResult[];
  loading: boolean;
  setQuery: (q: string) => void;
  clear: () => void;
}

const DEBOUNCE_MS = 200;

// TODO(public-screens): replace with real API calls to /api/projects, /api/people, /api/tags
function mockSearch(q: string): SearchResult[] {
  if (!q.trim()) return [];
  return [
    {
      type: 'project',
      slug: 'example-project',
      title: `Example project matching "${q}"`,
      url: '/projects/example-project',
    },
  ];
}

export function useSearch(): SearchState {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    if (!q.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(() => {
      // TODO(public-screens): replace with real fetch calls
      const found = mockSearch(q);
      setResults(found);
      setLoading(false);
    }, DEBOUNCE_MS);
  }, []);

  const clear = useCallback(() => {
    setQueryState('');
    setResults([]);
    setLoading(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { query, results, loading, setQuery, clear };
}
