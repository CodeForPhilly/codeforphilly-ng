/**
 * Account screen tests focused on the GitHub-link affordances inside
 * the Identity card. The persistent "Connect GitHub" nag banner has
 * been hoisted to a top-level ConnectGitHubBanner component (rendered
 * by AppShell on every page), and is covered by its own test file.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderScreen, mockOk } from './test-utils.js';
import { Account } from '../src/screens/Account.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

interface MeShape {
  person: { id: string; slug: string; fullName: string; accountLevel: string; avatarUrl: string | null } | null;
  accountLevel: string;
  hasGitHubLink: boolean;
  lastLoginMethod: 'github' | 'legacy_password' | 'password_reset' | null;
}

const SESSIONS = [
  {
    jti: 'sess-1',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120',
    ipAddress: '203.0.113.1',
    issuedAt: '2026-05-01T00:00:00Z',
    current: false,
  },
  {
    jti: 'sess-2',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/121',
    ipAddress: '203.0.113.2',
    issuedAt: '2026-05-02T00:00:00Z',
    current: false,
  },
];

function mockApi(me: MeShape, sessions: unknown[] = []): void {
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
        new Response(JSON.stringify(mockOk(sessions)), {
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

describe('Account — accessibility structure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the "Settings" breadcrumb trail from app-shell.md', async () => {
    mockApi(githubPerson);
    render();
    const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByText('Settings')).toHaveAttribute('aria-current', 'page');
  });

  it('names each Revoke button after its own session', async () => {
    mockApi(githubPerson, SESSIONS);
    render();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Revoke session on Chrome on macOS' }))
        .toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: 'Revoke session on Firefox on Windows' }),
    ).toBeInTheDocument();
    // The visible text is still "Revoke" on both (SC 2.5.3 keeps it a substring).
    expect(screen.getAllByRole('button', { name: /^Revoke session on/ })).toHaveLength(2);
  });

  it('exposes session timestamps as machine-readable <time>', async () => {
    mockApi(githubPerson, SESSIONS);
    render();
    await waitFor(() => {
      expect(document.querySelector('time[datetime="2026-05-01T00:00:00Z"]')).not.toBeNull();
    });
  });
});
