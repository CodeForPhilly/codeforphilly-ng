import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from './test-utils.js';
import { AppHeader } from '../src/components/AppHeader.js';
import { AuthProvider } from '../src/hooks/useAuth.js';
import { NetworkErrorProvider } from '../src/components/NetworkErrorBanner.js';

function Wrapped() {
  return (
    <NetworkErrorProvider>
      <AuthProvider>
        <AppHeader />
      </AuthProvider>
    </NetworkErrorProvider>
  );
}

describe('AppHeader', () => {
  beforeEach(() => {
    // Default: anonymous user (404 on /api/auth/me)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the site name', async () => {
    renderWithRouter(<Wrapped />);
    expect(screen.getByText('Code for Philly')).toBeInTheDocument();
  });

  it('renders primary nav links', async () => {
    renderWithRouter(<Wrapped />);
    expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Help Wanted' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Members' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volunteer' })).toBeInTheDocument();
  });

  it('shows Sign in button(s) when anonymous', async () => {
    renderWithRouter(<Wrapped />);
    await waitFor(() => {
      // The header renders both desktop and mobile auth controls, so there
      // may be multiple "Sign in" links (one per breakpoint variant)
      const signInLinks = screen.getAllByRole('link', { name: 'Sign in' });
      expect(signInLinks.length).toBeGreaterThanOrEqual(1);
      expect(signInLinks[0]).toHaveAttribute('href', '/login');
    });
  });

  it('opens the About dropdown on click', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);

    const aboutBtn = screen.getByRole('button', { name: /about menu/i });
    await user.click(aboutBtn);

    await waitFor(() => {
      expect(screen.getByText('Mission')).toBeInTheDocument();
      expect(screen.getByText('Leadership')).toBeInTheDocument();
      expect(screen.getByText('Sponsor')).toBeInTheDocument();
    });
  });

  it('opens and closes the mobile sheet', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);

    const hamburger = screen.getByRole('button', { name: /open navigation menu/i });
    expect(hamburger).toBeInTheDocument();

    // Open
    await user.click(hamburger);

    await waitFor(() => {
      // Sheet content includes "Mobile navigation" aria-label
      expect(screen.getByRole('navigation', { name: /mobile navigation/i })).toBeInTheDocument();
    });

    // Close via Escape key
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: /mobile navigation/i })).not.toBeInTheDocument();
    });
  });
});
