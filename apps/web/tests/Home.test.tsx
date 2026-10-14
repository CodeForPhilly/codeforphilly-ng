import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderScreen, mockPaginated } from './test-utils.js';
import { Home } from '../src/screens/Home.js';
import { AuthProvider } from '../src/hooks/useAuth.js';
import { makeSummary } from './event-fixtures.js';

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
  it('hides the Upcoming Events strip entirely when nothing is upcoming', async () => {
    renderScreen(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Volunteer' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Upcoming Events' })).not.toBeInTheDocument();
  });

  it('shows upcoming events with a sign-in RSVP on the soonest row only', async () => {
    const fallback = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
      if (input.startsWith('/api/events')) {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              mockPaginated([
                makeSummary(),
                makeSummary({ id: 'e2', slug: 'second', title: 'Second Event' }),
              ]),
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return fallback(input, init);
    }) as typeof fetch);

    renderScreen(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Upcoming Events' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Second Event' })).toHaveAttribute('href', '/events/second');
    expect(screen.getAllByRole('link', { name: 'Sign in to RSVP' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'See all events →' })).toHaveAttribute('href', '/events');
  });
});
