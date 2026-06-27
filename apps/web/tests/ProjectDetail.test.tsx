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

  // #113 — Join / Leave membership UI
  function mockSignedIn(project: typeof PROJECT, accountLevel = 'user'): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              mockOk({
                person: { id: 'u1', slug: 'me', fullName: 'Me Person', accountLevel, avatarUrl: null },
                accountLevel,
              }),
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (
        input.includes('/api/projects/sample-project/updates') ||
        input.includes('/api/projects/sample-project/buzz') ||
        input.includes('/api/projects/sample-project/help-wanted')
      ) {
        return Promise.resolve(new Response(JSON.stringify(mockPaginated([])), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (input.startsWith('/api/projects/sample-project')) {
        return Promise.resolve(new Response(JSON.stringify(mockOk(project)), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
  }

  function renderDetail(): void {
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/projects/:slug" element={<ProjectDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/projects/sample-project'] },
    );
  }

  it('shows "Join Project" for a signed-in non-member', async () => {
    mockSignedIn(PROJECT); // memberships: []
    renderDetail();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /join project/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /leave project/i })).not.toBeInTheDocument();
  });

  it('shows "Leave project" for a member (not sole maintainer)', async () => {
    const asMember = {
      ...PROJECT,
      memberships: [
        { id: 'm1', role: 'contributor', isMaintainer: false, joinedAt: '2026-02-01T00:00:00Z', person: { slug: 'me', fullName: 'Me Person', avatarUrl: null } },
      ],
      counts: { ...PROJECT.counts, members: 1 },
    } as unknown as typeof PROJECT;
    mockSignedIn(asMember);
    renderDetail();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /leave project/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /join project/i })).not.toBeInTheDocument();
  });

  it('shows the soft-delete banner + Restore for staff viewing a deleted project', async () => {
    const deleted = { ...PROJECT, deletedAt: '2026-06-01T00:00:00Z' } as unknown as typeof PROJECT;
    mockSignedIn(deleted, 'staff');
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText(/this project is deleted/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument();
  });

  it('does not show the soft-delete banner for an active project', async () => {
    mockSignedIn({ ...PROJECT, deletedAt: null } as unknown as typeof PROJECT, 'staff');
    renderDetail();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sample Project', level: 1 })).toBeInTheDocument();
    });
    expect(screen.queryByText(/this project is deleted/i)).not.toBeInTheDocument();
  });

  it('shows the "More" actions dropdown for users with management permissions', async () => {
    const asAdmin = {
      ...PROJECT,
      permissions: { ...PROJECT.permissions, canManageMembers: true, canPostUpdate: true, canDelete: true },
    } as unknown as typeof PROJECT;
    mockSignedIn(asAdmin, 'administrator');
    renderDetail();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /more/i })).toBeInTheDocument();
    });
  });

  it('shows no "More" dropdown for anonymous viewers', async () => {
    // default beforeEach mock is anonymous with no permissions
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
    expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument();
  });
});
