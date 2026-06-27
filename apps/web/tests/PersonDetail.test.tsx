import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { renderScreen, mockOk } from './test-utils.js';
import { PersonDetail } from '../src/screens/PersonDetail.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

const BASE_PERSON = {
  id: '01951a3c-0000-7000-8000-000000000001',
  slug: 'jane-doe',
  fullName: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  avatarUrl: null,
  bio: 'A civic technologist.',
  bioHtml: '<p>A civic technologist.</p>',
  accountLevel: 'user',
  slackHandle: null,
  email: null,
  tags: { topic: [], tech: [] },
  memberships: [],
  recentUpdates: [],
  permissions: { canEdit: false, canDelete: false },
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

function makeFetchMock(person: typeof BASE_PERSON) {
  return ((input: string) => {
    if (input.startsWith('/api/auth/me')) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (input.startsWith('/api/people/jane-doe')) {
      return Promise.resolve(
        new Response(JSON.stringify(mockOk(person)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch;
}

describe('PersonDetail Contact sidebar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders neither Contact section nor email when both fields are absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeFetchMock(BASE_PERSON));
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/members/:slug" element={<PersonDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/members/jane-doe'] },
    );
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Jane Doe', level: 1 })).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: /^contact$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /dm on slack/i })).not.toBeInTheDocument();
  });

  it('renders DM on Slack link when slackHandle is set', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMock({ ...BASE_PERSON, slackHandle: 'jane-doe' }),
    );
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/members/:slug" element={<PersonDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/members/jane-doe'] },
    );
    await waitFor(() => {
      const dm = screen.getByRole('link', { name: /dm on slack/i });
      expect(dm).toHaveAttribute('href', 'https://codeforphilly.slack.com/team/jane-doe');
    });
  });

  it('renders mailto link when email is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMock({ ...BASE_PERSON, email: 'jane@example.com' }),
    );
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/members/:slug" element={<PersonDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/members/jane-doe'] },
    );
    await waitFor(() => {
      const mailto = screen.getByRole('link', { name: /jane@example\.com/i });
      expect(mailto).toHaveAttribute('href', 'mailto:jane@example.com');
    });
  });

  // #113 — "Manage account" link, self only
  it('shows a "Manage account" link to /account when viewing your own profile', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              mockOk({
                person: { id: BASE_PERSON.id, slug: 'jane-doe', fullName: 'Jane Doe', accountLevel: 'user', avatarUrl: null },
                accountLevel: 'user',
              }),
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (input.startsWith('/api/people/jane-doe')) {
        return Promise.resolve(new Response(JSON.stringify(mockOk(BASE_PERSON)), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/members/:slug" element={<PersonDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/members/jane-doe'] },
    );
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /manage account/i })).toHaveAttribute('href', '/account');
    });
  });

  it('does not show "Manage account" for anonymous viewers', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeFetchMock(BASE_PERSON));
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/members/:slug" element={<PersonDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/members/jane-doe'] },
    );
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Jane Doe', level: 1 })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /manage account/i })).not.toBeInTheDocument();
  });
});
