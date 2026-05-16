import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderScreen, mockPaginated } from './test-utils.js';
import { HelpWantedIndex } from '../src/screens/HelpWantedIndex.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

const SAMPLE_ROLE = {
  id: 'r1',
  project: { slug: 'sample', title: 'Sample Project' },
  postedBy: null,
  title: 'Frontend developer',
  description: 'Help us build a React app',
  descriptionHtml: '<p>Help us build a React app</p>',
  commitmentHoursPerWeek: 4,
  status: 'open',
  filledBy: null,
  filledAt: null,
  closedAt: null,
  tags: { topic: [], tech: [{ namespace: 'tech', slug: 'react', title: 'React' }] },
  interestCount: 0,
  permissions: {
    canEdit: false,
    canExpressInterest: false,
    alreadyExpressedInterest: false,
    canFill: false,
    canClose: false,
  },
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
};

describe('HelpWantedIndex', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) return Promise.resolve(new Response(null, { status: 404 }));
      if (input.startsWith('/api/help-wanted')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([SAMPLE_ROLE], { totalItems: 1 })), {
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

  it('renders the role with sign-in CTA for anonymous', async () => {
    renderScreen(
      <AuthProvider>
        <HelpWantedIndex />
      </AuthProvider>,
      { initialEntries: ['/help-wanted'] },
    );

    await waitFor(() => {
      expect(screen.getByText('Frontend developer')).toBeInTheDocument();
    });

    expect(screen.getByText(/~4 hrs\/week/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in to express interest/i })).toBeInTheDocument();
  });

  it('renders commitment radio filter options', async () => {
    renderScreen(
      <AuthProvider>
        <HelpWantedIndex />
      </AuthProvider>,
      { initialEntries: ['/help-wanted'] },
    );

    expect(screen.getByLabelText('Any')).toBeInTheDocument();
    expect(screen.getByLabelText('≤ 2 hrs/week')).toBeInTheDocument();
    expect(screen.getByLabelText('≤ 5 hrs/week')).toBeInTheDocument();
    expect(screen.getByLabelText('≤ 10 hrs/week')).toBeInTheDocument();
  });
});
