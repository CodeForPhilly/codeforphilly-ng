import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { NetworkErrorProvider } from '../src/components/NetworkErrorBanner.js';
import { useSearch } from '../src/hooks/useSearch.js';
import { mockPaginated } from './test-utils.js';

function wrapper({ children }: { children: React.ReactNode }) {
  return <NetworkErrorProvider>{children}</NetworkErrorProvider>;
}

describe('useSearch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /api/projects, /api/people, /api/tags in parallel with perPage=4', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/projects')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([{ slug: 'p1', title: 'Project One' }])), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (input.startsWith('/api/people')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([{ slug: 'm1', fullName: 'Member One' }])), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (input.startsWith('/api/tags')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([{ slug: 'react', namespace: 'tech', handle: 'tech.react', title: 'React' }])), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);

    const { result } = renderHook(() => useSearch(), { wrapper });

    act(() => {
      result.current.setQuery('react');
    });

    await waitFor(
      () => {
        expect(result.current.results.length).toBe(3);
      },
      { timeout: 3000 },
    );

    const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.startsWith('/api/projects?') && u.includes('perPage=4'))).toBe(true);
    expect(urls.some((u) => u.startsWith('/api/people?') && u.includes('perPage=4'))).toBe(true);
    expect(urls.some((u) => u.startsWith('/api/tags?') && u.includes('perPage=4'))).toBe(true);
  });
});
