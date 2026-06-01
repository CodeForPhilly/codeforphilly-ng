/**
 * Tests for ConnectGitHubBanner — the persistent "Connect your GitHub
 * account" nag rendered directly under the navbar on every page.
 *
 * Visibility rule: signed-in + hasGitHubLink === false + lastLoginMethod
 * ∈ {legacy_password, password_reset} + not dismissed.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderScreen, mockOk } from './test-utils.js';
import { ConnectGitHubBanner } from '../src/components/ConnectGitHubBanner.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

interface MeShape {
  person: { id: string; slug: string; fullName: string; accountLevel: string; avatarUrl: string | null } | null;
  accountLevel: string;
  hasGitHubLink: boolean;
  lastLoginMethod: 'github' | 'legacy_password' | 'password_reset' | null;
}

function mockMe(me: MeShape): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
    if (input.startsWith('/api/auth/me')) {
      return Promise.resolve(
        new Response(JSON.stringify(mockOk(me)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch);
}

const baseLegacyPerson: MeShape = {
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

const anonMe: MeShape = {
  person: null,
  accountLevel: 'anonymous',
  hasGitHubLink: false,
  lastLoginMethod: null,
};

function render() {
  return renderScreen(
    <AuthProvider>
      <ConnectGitHubBanner />
    </AuthProvider>,
  );
}

describe('ConnectGitHubBanner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders for legacy-password user with no GitHub link', async () => {
    mockMe(baseLegacyPerson);
    render();
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /connect github/i }),
      ).toBeInTheDocument();
    });
    // CTA form posts to the link endpoint.
    const region = screen.getByRole('region', { name: /connect github/i });
    expect(region.querySelector('form[action="/api/auth/link-github"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('renders for a user whose session was minted via password reset', async () => {
    mockMe({ ...baseLegacyPerson, lastLoginMethod: 'password_reset' });
    render();
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /connect github/i }),
      ).toBeInTheDocument();
    });
  });

  it('does not render for a github-signed-in user', async () => {
    mockMe({
      ...baseLegacyPerson,
      hasGitHubLink: true,
      lastLoginMethod: 'github',
    });
    render();
    // Wait for /api/auth/me to settle (loading → resolved). The
    // simplest signal is a tick: a known-true assertion plus a short
    // microtask gap.
    await new Promise((r) => setTimeout(r, 0));
    expect(
      screen.queryByRole('region', { name: /connect github/i }),
    ).not.toBeInTheDocument();
  });

  it('does not render for anonymous viewers', async () => {
    mockMe(anonMe);
    render();
    await new Promise((r) => setTimeout(r, 0));
    expect(
      screen.queryByRole('region', { name: /connect github/i }),
    ).not.toBeInTheDocument();
  });

  it('hides after the user clicks dismiss', async () => {
    mockMe(baseLegacyPerson);
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
