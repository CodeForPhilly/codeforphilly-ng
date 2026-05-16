import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NetworkErrorProvider } from '../src/components/NetworkErrorBanner.js';
import { TooltipProvider } from '../src/components/ui/tooltip.js';

/**
 * Render a component inside a MemoryRouter so that route-dependent components
 * (Link, NavLink, useNavigate, etc.) work in tests without a real browser.
 */
export function renderWithRouter(
  element: ReactElement,
  { initialEntries = ['/'] }: { initialEntries?: string[] } = {},
): RenderResult {
  return render(
    <MemoryRouter initialEntries={initialEntries}>{element}</MemoryRouter>,
  );
}

/**
 * Render a screen inside a MemoryRouter + fresh QueryClient + NetworkErrorProvider.
 * Use for screen-level smoke tests that issue fetch() against the API.
 */
export function renderScreen(
  element: ReactElement,
  { initialEntries = ['/'] }: { initialEntries?: string[] } = {},
): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
    },
  });
  const result = render(
    <TooltipProvider>
      <NetworkErrorProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={initialEntries}>{element}</MemoryRouter>
        </QueryClientProvider>
      </NetworkErrorProvider>
    </TooltipProvider>,
  );
  return { ...result, queryClient };
}

/**
 * Build a successful response envelope mock matching specs/api/conventions.md.
 */
export function mockOk<T>(data: T) {
  return {
    success: true as const,
    data,
    metadata: { timestamp: new Date().toISOString() },
  };
}

export function mockPaginated<T>(data: T[], opts: Partial<{ page: number; perPage: number; totalItems: number; facets: unknown }> = {}) {
  const page = opts.page ?? 1;
  const perPage = opts.perPage ?? 30;
  const totalItems = opts.totalItems ?? data.length;
  return {
    success: true as const,
    data,
    metadata: {
      timestamp: new Date().toISOString(),
      page,
      perPage,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / perPage)),
      facets: opts.facets ?? {},
    },
  };
}
