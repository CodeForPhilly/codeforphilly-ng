import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router';
import { renderScreen, mockOk, mockPaginated } from './test-utils.js';
import { ProjectEdit } from '../src/screens/ProjectEdit.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

const ME = {
  id: 'u1',
  slug: 'me',
  fullName: 'Me User',
  avatarUrl: null,
  accountLevel: 'user' as const,
};

const NEW_PROJECT = {
  id: 'p1',
  slug: 'my-new-thing',
  title: 'My new thing',
  summary: null,
  overview: null,
  overviewHtml: '',
  stage: 'commenting',
  stageProgress: 0.1,
  maintainer: null,
  memberships: [],
  openHelpWantedRoles: [],
  tags: { topic: [], tech: [], event: [] },
  links: { usersUrl: null, developersUrl: null, chatChannel: null },
  counts: { updates: 0, buzz: 0, members: 0 },
  permissions: {
    canEdit: true,
    canManageMembers: true,
    canPostUpdate: true,
    canLogBuzz: true,
    canPostHelpWanted: true,
    canDelete: false,
  },
  featured: false,
  createdAt: '2026-05-15T00:00:00Z',
  updatedAt: '2026-05-15T00:00:00Z',
};

describe('ProjectEdit (create)', () => {
  let createBody: unknown = null;

  beforeEach(() => {
    createBody = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockOk({ person: ME, accountLevel: 'user' })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (input.startsWith('/api/tags')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([])), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      // Slug availability check — 404 = available
      if (input.startsWith('/api/projects/my-new-thing') && init?.method !== 'POST') {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (input === '/api/projects' && init?.method === 'POST') {
        createBody = init.body ? JSON.parse(String(init.body)) : null;
        return Promise.resolve(
          new Response(JSON.stringify(mockOk(NEW_PROJECT)), {
            status: 201,
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

  it('submits a new project and includes the auto-slug', async () => {
    const user = userEvent.setup();
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/projects/create" element={<ProjectEdit mode="create" />} />
          <Route path="/projects/:slug" element={<div>NAVIGATED:{location.pathname}</div>} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/projects/create'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /new project/i })).toBeInTheDocument();
    });

    const titleInput = screen.getByLabelText(/title/i);
    await user.type(titleInput, 'My new thing');

    // Slug should auto-fill via slugify
    await waitFor(() => {
      const slug = screen.getByLabelText(/slug/i) as HTMLInputElement;
      expect(slug.value).toBe('my-new-thing');
    });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(createBody).not.toBeNull();
    });

    const body = createBody as { title: string; slug: string; stage: string };
    expect(body.title).toBe('My new thing');
    expect(body.slug).toBe('my-new-thing');
    expect(body.stage).toBe('commenting');
  });
});
