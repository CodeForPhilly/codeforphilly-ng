import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderScreen, mockPaginated } from './test-utils.js';
import { ProjectsIndex } from '../src/screens/ProjectsIndex.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

const SAMPLE_PROJECT = {
  id: 'p1',
  slug: 'sample-project',
  title: 'Sample Project',
  summary: 'A great civic project',
  stage: 'maintaining',
  overviewExcerpt: 'Overview excerpt',
  maintainer: null,
  memberCount: 0,
  members: [],
  links: { usersUrl: null, developersUrl: null, chatChannel: null },
  openHelpWantedCount: 2,
  tags: [{ namespace: 'tech', slug: 'react', title: 'React' }],
  updatedAt: '2026-05-10T12:00:00Z',
};

describe('ProjectsIndex', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (input.startsWith('/api/projects')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([SAMPLE_PROJECT], { totalItems: 1, facets: { byTech: [{ handle: 'tech.react', slug: 'react', title: 'React', count: 1 }] } })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header with totalItems badge', async () => {
    renderScreen(
      <AuthProvider>
        <ProjectsIndex />
      </AuthProvider>,
      { initialEntries: ['/projects'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /civic projects directory/i })).toBeInTheDocument();
    });
  });

  it('renders project cards with title, stage badge, and help-wanted badge', async () => {
    renderScreen(
      <AuthProvider>
        <ProjectsIndex />
      </AuthProvider>,
      { initialEntries: ['/projects'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Sample Project' })).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Maintaining/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Help wanted \(2\)/)).toBeInTheDocument();
  });

  it('does not render Add Project button for anonymous users', async () => {
    renderScreen(
      <AuthProvider>
        <ProjectsIndex />
      </AuthProvider>,
      { initialEntries: ['/projects'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /civic projects directory/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /add project/i })).not.toBeInTheDocument();
  });
});
