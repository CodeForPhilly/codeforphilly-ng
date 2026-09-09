import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

  it('renders a labelled home link with the logo image', async () => {
    renderWithRouter(<Wrapped />);
    const home = screen.getByRole('link', { name: /code for philly home/i });
    expect(home).toBeInTheDocument();
    expect(home).toHaveAttribute('href', '/');
    expect(home.querySelector('img')).toHaveAttribute('alt', 'Code for Philly');
  });

  it('renders primary nav links', async () => {
    renderWithRouter(<Wrapped />);
    const nav = screen.getByRole('navigation', { name: /primary navigation/i });
    expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Help Wanted' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Members' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'About' })).toBeInTheDocument();

    // The Volunteer CTA lives in the utility cluster, not the content nav —
    // it is the rightmost header element (specs/behaviors/app-shell.md).
    const volunteer = screen.getByRole('link', { name: 'Volunteer' });
    expect(volunteer).toHaveAttribute('href', '/volunteer');
    expect(nav).not.toContainElement(volunteer);
  });

  it('renders the GitHub link in the utility cluster', async () => {
    renderWithRouter(<Wrapped />);
    const gh = screen.getByRole('link', { name: 'Code for Philly on GitHub' });
    expect(gh).toHaveAttribute('href', 'https://github.com/CodeForPhilly');
    expect(gh).toHaveAttribute('target', '_blank');
    expect(gh).toHaveAttribute('rel', 'noopener noreferrer');
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

    // The trigger's visible text is its accessible name — no aria-label.
    const aboutBtn = screen.getByRole('button', { name: 'About' });
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
    // aria-expanded is supplied by Radix's Dialog.Trigger, not hand-written.
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');

    // Open
    await user.click(hamburger);

    await waitFor(() => {
      // Sheet content includes "Mobile navigation" aria-label
      expect(screen.getByRole('navigation', { name: /mobile navigation/i })).toBeInTheDocument();
    });
    expect(hamburger).toHaveAttribute('aria-expanded', 'true');

    // Close via Escape key
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: /mobile navigation/i })).not.toBeInTheDocument();
    });
  });

  it('gives the mobile sheet dialog an accessible name', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);

    await user.click(screen.getByRole('button', { name: /open navigation menu/i }));

    const dialog = await screen.findByRole('dialog', { name: 'Menu' });
    expect(dialog).toBeInTheDocument();
  });

  it('lists GitHub and Volunteer in the mobile sheet', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);

    await user.click(screen.getByRole('button', { name: /open navigation menu/i }));

    const nav = await screen.findByRole('navigation', { name: /mobile navigation/i });
    expect(within(nav).getByRole('link', { name: 'GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/CodeForPhilly',
    );
    expect(within(nav).getByRole('link', { name: 'Volunteer' })).toHaveAttribute(
      'href',
      '/volunteer',
    );
  });

  it('closes the mobile sheet when a sheet link navigates', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);

    await user.click(screen.getByRole('button', { name: /open navigation menu/i }));
    const nav = await screen.findByRole('navigation', { name: /mobile navigation/i });

    await user.click(within(nav).getByRole('link', { name: 'Members' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
    });
  });

  it('closes the mobile sheet when the inline search navigates', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);

    await user.click(screen.getByRole('button', { name: /open navigation menu/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Menu' });

    // Scope to the sheet: jsdom applies no breakpoints, so the desktop
    // search box is in the DOM too.
    await user.type(
      within(dialog).getByRole('searchbox', { name: /search the site/i }),
      'civic{Enter}',
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
    });
  });
});
