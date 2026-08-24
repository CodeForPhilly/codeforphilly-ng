import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderScreen, mockPaginated } from './test-utils.js';
import { Volunteer } from '../src/screens/Volunteer.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

const MEETUP_URL = 'https://www.meetup.com/Code-for-Philly/';
const START_PROJECT_URL =
  'https://github.com/CodeForPhilly/partnerships/blob/master/creating-new-partnerships/first-steps.md';

describe('Volunteer', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (input.startsWith('/api/projects')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([], { totalItems: 268 })), {
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

  function renderVolunteer() {
    return renderScreen(
      <AuthProvider>
        <Volunteer />
      </AuthProvider>,
    );
  }

  it('renders the hero headline', () => {
    renderVolunteer();
    expect(
      screen.getByRole('heading', {
        name: /volunteer with code for philly/i,
        level: 1,
      }),
    ).toBeInTheDocument();
  });

  it('points "When we meet →" at the live Meetup group, not the dead GitBook page', () => {
    renderVolunteer();
    const link = screen.getByRole('link', { name: /when we meet/i });
    expect(link).toHaveAttribute('href', MEETUP_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('points "Read the guide →" at the partnerships repo, not the dead GitBook page', () => {
    renderVolunteer();
    const link = screen.getByRole('link', { name: /read the guide/i });
    expect(link).toHaveAttribute('href', START_PROJECT_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('has no codeforphilly.gitbook.io links anywhere on the screen', async () => {
    const { container } = renderVolunteer();

    // Wait for the live project count so the fully-settled DOM is asserted on.
    await waitFor(() => {
      expect(screen.getByText(/browse 268 active projects/i)).toBeInTheDocument();
    });

    const hrefs = Array.from(container.querySelectorAll('a')).map(
      (a) => a.getAttribute('href') ?? '',
    );
    expect(hrefs.filter((h) => h.includes('gitbook.io'))).toHaveLength(0);
    expect(container.innerHTML).not.toContain('codeforphilly.gitbook.io');
  });
});
