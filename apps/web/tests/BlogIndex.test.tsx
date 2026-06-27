import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderScreen, mockPaginated } from './test-utils.js';
import { BlogIndex } from '../src/screens/BlogIndex.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

const SAMPLE_POST = {
  id: '01951a3c-0000-7000-8000-aaaaaaaaaaaa',
  slug: 'civic-tech-roundup',
  title: 'Civic Tech Roundup',
  summary: 'A short blurb.',
  author: { slug: 'jane', fullName: 'Jane Coder', avatarUrl: null },
  postedAt: '2026-05-10T12:00:00Z',
  editedAt: null,
  featuredImageKey: null,
  featuredImageUrl: null,
  body: '# Heading\n\nbody',
  bodyHtml: '<h1>Heading</h1><p>body</p>',
  createdAt: '2026-05-10T12:00:00Z',
  updatedAt: '2026-05-10T12:00:00Z',
};

describe('BlogIndex', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (input.startsWith('/api/blog-posts')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([SAMPLE_POST], { totalItems: 1 })), {
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

  it('renders the page header', async () => {
    renderScreen(
      <AuthProvider>
        <BlogIndex />
      </AuthProvider>,
      { initialEntries: ['/blog'] },
    );
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^blog$/i })).toBeInTheDocument();
    });
  });

  it('renders a post card with title link, author, and summary', async () => {
    renderScreen(
      <AuthProvider>
        <BlogIndex />
      </AuthProvider>,
      { initialEntries: ['/blog'] },
    );
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Civic Tech Roundup' })).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Jane Coder' })).toBeInTheDocument();
    expect(screen.getByText('A short blurb.')).toBeInTheDocument();
  });

  it('falls back to a bodyHtml first-paragraph excerpt when summary is null', async () => {
    const noSummary = {
      ...SAMPLE_POST,
      summary: null,
      bodyHtml: '<h1>Heading</h1><p>First paragraph of the body.</p><p>Second.</p>',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) return Promise.resolve(new Response(null, { status: 404 }));
      if (input.startsWith('/api/blog-posts')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([noSummary], { totalItems: 1 })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
    renderScreen(
      <AuthProvider>
        <BlogIndex />
      </AuthProvider>,
      { initialEntries: ['/blog'] },
    );
    await waitFor(() => {
      expect(screen.getByText('First paragraph of the body.')).toBeInTheDocument();
    });
  });

  it('renders the empty state when no posts are returned', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (input.startsWith('/api/blog-posts')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([], { totalItems: 0 })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);

    renderScreen(
      <AuthProvider>
        <BlogIndex />
      </AuthProvider>,
      { initialEntries: ['/blog'] },
    );
    await waitFor(() => {
      expect(screen.getByText(/no blog posts yet/i)).toBeInTheDocument();
    });
  });
});
