import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderScreen, mockPaginated } from './test-utils.js';
import { Home } from '../src/screens/Home.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

describe('Home', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) return Promise.resolve(new Response(null, { status: 404 }));
      if (input.startsWith('/hero/manifest.json')) {
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (input.startsWith('/api/projects')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([], { totalItems: 42 })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(mockPaginated([])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the hero headline with the volunteer CTA for anonymous', async () => {
    renderScreen(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );

    expect(
      screen.getByRole('heading', {
        name: /contribute towards technology-related projects/i,
        level: 1,
      }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Volunteer' })).toBeInTheDocument();
    });
  });

  it('shows the get-involved cards', async () => {
    renderScreen(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Sponsor' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Start a Project' })).toBeInTheDocument();
  });

  it('routes the anonymous "Start a Project" card through login, not the dead GitBook URL', async () => {
    renderScreen(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );

    const card = screen.getByRole('link', { name: /Start a Project/i });
    expect(card).toHaveAttribute('href', '/login?return=/projects/create');
  });
});
