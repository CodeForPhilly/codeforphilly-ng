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
            id: '01927a5f-0000-7000-8000-000000000001',
            slug: 'jane-doe',
            fullName: 'Jane Doe',
            avatarUrl: null,
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
