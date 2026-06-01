/**
 * Account screen tests focused on the GitHub-link affordances inside
 * the Identity card. The persistent "Connect GitHub" nag banner has
 * been hoisted to a top-level ConnectGitHubBanner component (rendered
 * by AppShell on every page), and is covered by its own test file.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
    // Identity card has a form posting to the link endpoint.
    const forms = document.querySelectorAll('form[action="/api/auth/link-github"]');
    expect(forms.length).toBeGreaterThanOrEqual(1);
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
    // No link-github form when already connected.
    expect(
      document.querySelectorAll('form[action="/api/auth/link-github"]').length,
    ).toBe(0);
  });
});
