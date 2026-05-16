import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useNetworkError } from '@/components/NetworkErrorBanner';

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

async function performSearch(q: string): Promise<SearchResult[]> {
  const [projects, people, tags] = await Promise.all([
    api.projects.list({ q, perPage: 4 }),
    api.people.list({ q, perPage: 4 }),
    api.tags.list({ q, perPage: 4 }),
  ]);

  const out: SearchResult[] = [];
  for (const p of projects.data) {
    out.push({ type: 'project', slug: p.slug, title: p.title, url: `/projects/${p.slug}` });
  }
  for (const m of people.data) {
    out.push({ type: 'member', slug: m.slug, title: m.fullName, url: `/members/${m.slug}` });
  }
  for (const t of tags.data) {
    out.push({ type: 'tag', slug: t.handle, title: t.title, url: `/tags/${t.namespace}/${t.slug}` });
  }
  return out;
}

export function useSearch(): SearchState {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);
  const { showError } = useNetworkError();

  const setQuery = useCallback(
    (q: string) => {
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
      const reqId = ++reqIdRef.current;
      timerRef.current = setTimeout(() => {
        performSearch(q.trim())
          .then((found) => {
            if (reqIdRef.current === reqId) {
              setResults(found);
              setLoading(false);
            }
          })
          .catch((err: unknown) => {
            if (reqIdRef.current === reqId) {
              setResults([]);
              setLoading(false);
            }
            if (err instanceof ApiError && err.isServerError) {
              showError();
            } else if (!(err instanceof ApiError)) {
              showError('Network error. Please check your connection and try again.');
            }
          });
      }, DEBOUNCE_MS);
    },
    [showError],
  );

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
