import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { renderScreen, mockOk, mockPaginated } from './test-utils.js';
import { ProjectDetail } from '../src/screens/ProjectDetail.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

const PROJECT = {
  id: 'p1',
  slug: 'sample-project',
  title: 'Sample Project',
  summary: 'A great project',
  overview: '# Hello',
  overviewHtml: '<h3>Hello</h3>',
  stage: 'prototyping',
  stageProgress: 0.4,
  maintainer: null,
  memberships: [],
  openHelpWantedRoles: [],
  tags: { topic: [], tech: [{ namespace: 'tech', slug: 'react', title: 'React' }], event: [] },
  links: { usersUrl: 'https://example.com', developersUrl: null, chatChannel: 'sample' },
  counts: { updates: 0, buzz: 0, members: 0 },
  permissions: {
    canEdit: false,
    canManageMembers: false,
    canPostUpdate: false,
    canLogBuzz: false,
    canPostHelpWanted: false,
    canDelete: false,
  },
  featured: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-10T00:00:00Z',
};

describe('ProjectDetail', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) return Promise.resolve(new Response(null, { status: 404 }));
      if (input.includes('/api/projects/sample-project/updates')) {
        return Promise.resolve(new Response(JSON.stringify(mockPaginated([])), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (input.includes('/api/projects/sample-project/buzz')) {
        return Promise.resolve(new Response(JSON.stringify(mockPaginated([])), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (input.includes('/api/projects/sample-project/help-wanted')) {
        return Promise.resolve(new Response(JSON.stringify(mockPaginated([])), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (input.startsWith('/api/projects/sample-project')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockOk(PROJECT)), { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the title, overview, and Sign-in CTA for anonymous', async () => {
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/projects/:slug" element={<ProjectDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/projects/sample-project'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sample Project', level: 1 })).toBeInTheDocument();
    });

    // overviewHtml renders via MarkdownView (server-rendered HTML)
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument();

    // Anonymous → sign-in replacement
    expect(screen.getByRole('link', { name: /sign in to contribute/i })).toBeInTheDocument();

    // No edit button for anonymous
    expect(screen.queryByRole('link', { name: /^Edit Project/i })).not.toBeInTheDocument();
  });

  it('shows users-site link and chat channel link', async () => {
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/projects/:slug" element={<ProjectDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/projects/sample-project'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /users' site/i })).toBeInTheDocument();
    });
    const chatLink = screen.getByRole('link', { name: /chat channel/i });
    expect(chatLink).toHaveAttribute('href', '/chat?channel=sample');
  });

  it('renders the Share to Slack button alongside Copy link', async () => {
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/projects/:slug" element={<ProjectDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/projects/sample-project'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^copy link$/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /share to slack/i })).toBeInTheDocument();
  });

  it('renders "What does this stage mean?" link', async () => {
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/projects/:slug" element={<ProjectDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/projects/sample-project'] },
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /what does this stage mean\?/i }),
      ).toBeInTheDocument();
    });
  });

  it('does not render Edit on GitHub when developersUrl is absent', async () => {
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/projects/:slug" element={<ProjectDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/projects/sample-project'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sample Project', level: 1 })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /edit on github/i })).not.toBeInTheDocument();
  });

  it('renders Edit on GitHub when developersUrl is a github.com URL', async () => {
    // Override the fetch mock for this case to add a github developersUrl.
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) return Promise.resolve(new Response(null, { status: 404 }));
      if (input.includes('/api/projects/sample-project/updates')) {
        return Promise.resolve(new Response(JSON.stringify(mockPaginated([])), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (input.includes('/api/projects/sample-project/buzz')) {
        return Promise.resolve(new Response(JSON.stringify(mockPaginated([])), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (input.includes('/api/projects/sample-project/help-wanted')) {
        return Promise.resolve(new Response(JSON.stringify(mockPaginated([])), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (input.startsWith('/api/projects/sample-project')) {
        const projectWithGithub = {
          ...PROJECT,
          links: { ...PROJECT.links, developersUrl: 'https://github.com/codeforphilly/sample-project' },
        };
        return Promise.resolve(
          new Response(JSON.stringify(mockOk(projectWithGithub)), { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);

    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/projects/:slug" element={<ProjectDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/projects/sample-project'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /edit on github/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /edit on github/i })).toHaveAttribute(
      'href',
      'https://github.com/codeforphilly/sample-project',
    );
  });
});
