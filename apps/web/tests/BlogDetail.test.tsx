import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { renderScreen, mockOk } from './test-utils.js';
import { BlogDetail } from '../src/screens/BlogDetail.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

const POST = {
  id: '01951a3c-0000-7000-8000-bbbbbbbbbbbb',
  slug: 'roundup',
  title: 'Civic Tech Roundup',
  summary: null,
  author: null,
  postedAt: '2026-05-10T12:00:00Z',
  editedAt: null,
  featuredImageKey: null,
  featuredImageUrl: null,
  body: '# x',
  bodyHtml: '<p>Body</p>',
  tags: [{ namespace: 'topic', slug: 'transit', title: 'Transit' }],
  createdAt: '2026-05-10T12:00:00Z',
  updatedAt: '2026-05-10T12:00:00Z',
};

describe('BlogDetail tag chips', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mock(post: typeof POST): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) return Promise.resolve(new Response(null, { status: 404 }));
      if (input.startsWith('/api/blog-posts/roundup')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockOk(post)), { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
  }

  function render(): void {
    renderScreen(
      <AuthProvider>
        <Routes>
          <Route path="/blog/:slug" element={<BlogDetail />} />
        </Routes>
      </AuthProvider>,
      { initialEntries: ['/blog/roundup'] },
    );
  }

  it('renders tag chips linking to /blog?tag=<handle>', async () => {
    mock(POST);
    render();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Transit' })).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Transit' })).toHaveAttribute('href', '/blog?tag=topic.transit');
  });

  it('renders no tag chips when the post has no tags', async () => {
    mock({ ...POST, tags: [] } as unknown as typeof POST);
    render();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Civic Tech Roundup' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: 'Transit' })).not.toBeInTheDocument();
  });
});
