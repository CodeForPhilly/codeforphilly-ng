/**
 * Account screen tests focused on the phase-D additions:
 *   - Connect-GitHub banner renders only for legacy-credential users
 *     who haven't linked yet.
 *   - Identity card swaps "Manage on GitHub" for "Connect GitHub" when
 *     hasGitHubLink is false.
 *   - Banner dismiss button hides it for the rest of the session.
 *
 * The existing Account page predates this test file — these tests focus
 * narrowly on the banner + identity-card branches and leave the
 * newsletter / sessions / claim-legacy regions alone.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderScreen, mockOk } from './test-utils.js';
import { Account } from '../src/screens/Account.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

interface MeShape {
  person: { id: string; slug: string; fullName: string; accountLevel: string; avatarUrl: string | null } | null;
  accountLevel: string;
  hasGitHubLink: boolean;
  lastLoginMethod: 'github' | 'legacy_password' | 'password_reset' | null;
}

function mockApi(me: MeShape): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
    if (input.startsWith('/api/auth/me')) {
      return Promise.resolve(
        new Response(JSON.stringify(mockOk(me)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (input.startsWith('/api/auth/sessions')) {
      return Promise.resolve(
        new Response(JSON.stringify(mockOk([])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch);
}

const legacyPerson: MeShape = {
  person: {
    id: '01951a3c-0000-7000-8000-0000ffffff01',
    slug: 'legacy-user',
    fullName: 'Legacy User',
    accountLevel: 'user',
    avatarUrl: null,
  },
  accountLevel: 'user',
  hasGitHubLink: false,
  lastLoginMethod: 'legacy_password',
};

const githubPerson: MeShape = {
  person: {
    id: '01951a3c-0000-7000-8000-0000ffffff02',
    slug: 'gh-user',
    fullName: 'GH User',
    accountLevel: 'user',
    avatarUrl: null,
  },
  accountLevel: 'user',
  hasGitHubLink: true,
  lastLoginMethod: 'github',
};

function render() {
  return renderScreen(
    <AuthProvider>
      <Account />
    </AuthProvider>,
    { initialEntries: ['/account'] },
  );
}

describe('Account — Connect-GitHub banner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders for a legacy-password user with no GitHub link', async () => {
    mockApi(legacyPerson);
    render();
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /connect github/i }),
      ).toBeInTheDocument();
    });
    // Banner has a Connect button + a Dismiss button
    const region = screen.getByRole('region', { name: /connect github/i });
    expect(region.querySelector('form[action="/api/auth/link-github"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('does not render for a github-signed-in user', async () => {
    mockApi(githubPerson);
    render();
    // Wait for the Identity card to render — that proves the page is past loading.
    await waitFor(() => {
      expect(screen.getByText(/connected — primary identity/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('region', { name: /connect github/i }),
    ).not.toBeInTheDocument();
  });

  it('dismiss button hides the banner for the rest of the session', async () => {
    mockApi(legacyPerson);
    render();
    const dismissBtn = await screen.findByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissBtn);
    await waitFor(() => {
      expect(
        screen.queryByRole('region', { name: /connect github/i }),
      ).not.toBeInTheDocument();
    });
  });
});

describe('Account — Identity card', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the "Connect GitHub" form when hasGitHubLink is false', async () => {
    mockApi(legacyPerson);
    render();
    await waitFor(() => {
      expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    });
    // Two forms post to the link endpoint: banner + identity card
    const forms = document.querySelectorAll('form[action="/api/auth/link-github"]');
    expect(forms.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the "Manage on GitHub" link when hasGitHubLink is true', async () => {
    mockApi(githubPerson);
    render();
    await waitFor(() => {
      expect(screen.getByText(/connected — primary identity/i)).toBeInTheDocument();
    });
    expect(
      screen.getByRole('link', { name: /manage on github/i }),
    ).toHaveAttribute('href', 'https://github.com/settings');
    // No link-github form when already connected
    expect(
      document.querySelectorAll('form[action="/api/auth/link-github"]').length,
    ).toBe(0);
  });
});
