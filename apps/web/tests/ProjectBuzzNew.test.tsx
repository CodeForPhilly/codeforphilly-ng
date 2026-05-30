import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { renderScreen, mockOk } from './test-utils.js';
import { ProjectBuzzNew } from '../src/screens/ProjectBuzzNew.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

const SIGNED_IN_PERSON = {
  data: {
    person: {
      id: '01951a3c-0000-7000-8000-000000000001',
      slug: 'jane-doe',
      fullName: 'Jane Doe',
      avatarUrl: null,
      accountLevel: 'user',
    },
    accountLevel: 'user',
  },
};

function renderForm() {
  return renderScreen(
    <AuthProvider>
      <Routes>
        <Route path="/projects/:slug/buzz/new" element={<ProjectBuzzNew />} />
        <Route path="/projects/:slug" element={<div>Project page</div>} />
        <Route path="/login" element={<div>Login page</div>} />
      </Routes>
    </AuthProvider>,
    { initialEntries: ['/projects/transit-app/buzz/new'] },
  );
}

describe('ProjectBuzzNew', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects anonymous callers to /login with return-to', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);

    renderForm();
    await waitFor(() => {
      expect(screen.getByText(/login page/i)).toBeInTheDocument();
    });
  });

  describe('signed-in', () => {
    beforeEach(() => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
        if (input.startsWith('/api/auth/me')) {
          return Promise.resolve(
            new Response(JSON.stringify(SIGNED_IN_PERSON), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (
          input === '/api/projects/transit-app/buzz' &&
          init?.method === 'POST'
        ) {
          return Promise.resolve(
            new Response(
              JSON.stringify(
                mockOk({
                  id: 'b1',
                  slug: 'fake-buzz',
                  project: { slug: 'transit-app', title: 'Transit' },
                  postedBy: null,
                  headline: 'Hello',
                  url: 'https://example.com',
                  publishedAt: '2026-05-01T00:00:00Z',
                  summary: null,
                  summaryHtml: '',
                  imageUrl: null,
                  permissions: { canEdit: false, canDelete: false },
                  createdAt: '2026-05-01T00:00:00Z',
                  updatedAt: '2026-05-01T00:00:00Z',
                }),
              ),
              { status: 201, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }) as typeof fetch);
    });

    it('renders the form with required fields', async () => {
      renderForm();
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /log buzz/i })).toBeInTheDocument();
      });
      expect(screen.getByLabelText(/headline/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/url/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/published/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/summary/i)).toBeInTheDocument();
    });

    it('disables submit while required fields are empty', async () => {
      renderForm();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /log buzz/i })).toBeInTheDocument();
      });
      const submit = screen.getByRole('button', { name: /log buzz/i });
      expect(submit).toBeDisabled();
    });

    it('enables submit once headline + url are filled', async () => {
      renderForm();
      await waitFor(() => {
        expect(screen.getByLabelText(/headline/i)).toBeInTheDocument();
      });
      fireEvent.change(screen.getByLabelText(/headline/i), { target: { value: 'Hello' } });
      fireEvent.change(screen.getByLabelText(/url/i), {
        target: { value: 'https://example.com' },
      });
      expect(screen.getByRole('button', { name: /log buzz/i })).not.toBeDisabled();
    });

    it('navigates to the project page on successful submit', async () => {
      renderForm();
      await waitFor(() => {
        expect(screen.getByLabelText(/headline/i)).toBeInTheDocument();
      });
      fireEvent.change(screen.getByLabelText(/headline/i), { target: { value: 'Hello' } });
      fireEvent.change(screen.getByLabelText(/url/i), {
        target: { value: 'https://example.com' },
      });
      fireEvent.click(screen.getByRole('button', { name: /log buzz/i }));
      await waitFor(() => {
        expect(screen.getByText(/project page/i)).toBeInTheDocument();
      });
    });
  });
});
