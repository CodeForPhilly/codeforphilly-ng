import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from './test-utils.js';
import { AuthProvider, useAuth } from '../src/hooks/useAuth.js';

// Helper component to expose auth state in tests
function AuthDisplay() {
  const { person, loading } = useAuth();
  if (loading) return <div data-testid="loading">loading</div>;
  if (!person) return <div data-testid="anon">anonymous</div>;
  return <div data-testid="user">{person.fullName}</div>;
}

function Wrapped() {
  return (
    <AuthProvider>
      <AuthDisplay />
    </AuthProvider>
  );
}

describe('useAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    // Make fetch hang indefinitely
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise(() => {}),
    );

    renderWithRouter(<Wrapped />);
    expect(screen.getByTestId('loading')).toBeInTheDocument();
  });

  it('shows anonymous when /api/auth/me returns 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 401 }),
    );

    renderWithRouter(<Wrapped />);

    await waitFor(() => {
      expect(screen.getByTestId('anon')).toBeInTheDocument();
    });
  });

  it('shows anonymous when /api/auth/me returns 404 (not yet implemented)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 }),
    );

    renderWithRouter(<Wrapped />);

    await waitFor(() => {
      expect(screen.getByTestId('anon')).toBeInTheDocument();
    });
  });

  it('shows anonymous when fetch throws (network error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Failed to fetch'),
    );

    renderWithRouter(<Wrapped />);

    await waitFor(() => {
      expect(screen.getByTestId('anon')).toBeInTheDocument();
    });
  });

  it('shows user name when /api/auth/me returns a person', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            person: {
              id: '01927a5f-0000-7000-8000-000000000001',
              slug: 'jane-doe',
              fullName: 'Jane Doe',
              avatarUrl: null,
              accountLevel: 'user',
            },
            accountLevel: 'user',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    renderWithRouter(<Wrapped />);

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('Jane Doe');
    });
  });
});

describe('session refresh (specs/behaviors/authorization.md → "The SPA keeps the session alive")', () => {
  const me = (person: unknown) =>
    new Response(JSON.stringify({ success: true, data: { person, accountLevel: person ? 'user' : 'anonymous' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const PERSON = { id: 'p1', slug: 'jane', fullName: 'Jane Doe', avatarUrl: null, accountLevel: 'user' };

  afterEach(() => {
    document.cookie = 'cfp_has_session=; max-age=0; path=/';
    vi.restoreAllMocks();
  });

  it('refreshes on load when the hint cookie says a session exists', async () => {
    document.cookie = 'cfp_has_session=1; path=/';
    let signedIn = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/auth/refresh') {
        signedIn = true;
        return new Response(JSON.stringify({ success: true, data: null }), { status: 200 });
      }
      return me(signedIn ? PERSON : null);
    });

    renderWithRouter(<Wrapped />);
    expect(await screen.findByTestId('user')).toHaveTextContent('Jane Doe');
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/auth/refresh')).toHaveLength(1);
  });

  it('never refreshes for an anonymous visitor without the hint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => me(null));

    renderWithRouter(<Wrapped />);
    expect(await screen.findByTestId('anon')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/auth/refresh')).toBe(false);
  });

  it('retries an API call once after refreshing on a 401', async () => {
    const { api } = await import('../src/lib/api.js');
    let refreshed = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/auth/refresh') {
        refreshed = true;
        return new Response(JSON.stringify({ success: true, data: null }), { status: 200 });
      }
      if (!refreshed) {
        return new Response(JSON.stringify({ success: false, error: { code: 'unauthenticated', message: 'no' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: [], metadata: { totalItems: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await api.projects.list({ perPage: 1 });
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
      '/api/projects?perPage=1',
      '/api/auth/refresh',
      '/api/projects?perPage=1',
    ]);
  });
});
