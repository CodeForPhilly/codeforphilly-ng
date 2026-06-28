/**
 * Account screen — self deactivate / reactivate Danger Zone.
 *
 * Spec: specs/behaviors/person-lifecycle.md, specs/api/people.md
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderScreen, mockOk } from './test-utils.js';
import { Account } from '../src/screens/Account.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

interface MeShape {
  person: { id: string; slug: string; fullName: string; accountLevel: string; avatarUrl: string | null } | null;
  accountLevel: string;
  hasGitHubLink: boolean;
  lastLoginMethod: 'github' | 'legacy_password' | 'password_reset' | null;
}

const ME: MeShape = {
  person: {
    id: '01951a3c-0000-7000-8000-0000ffffff10',
    slug: 'jane-doe',
    fullName: 'Jane Doe',
    accountLevel: 'user',
    avatarUrl: null,
  },
  accountLevel: 'user',
  hasGitHubLink: true,
  lastLoginMethod: 'github',
};

function mockApi(deactivateImpl?: () => Response): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
    if (input.startsWith('/api/auth/me')) {
      return Promise.resolve(
        new Response(JSON.stringify(mockOk(ME)), {
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
    if (input.startsWith('/api/people/jane-doe/deactivate') && init?.method === 'POST') {
      return Promise.resolve(deactivateImpl ? deactivateImpl() : new Response(
        JSON.stringify(mockOk({ ...ME.person, deletedAt: '2026-06-01T00:00:00Z' })),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch);
}

describe('Account — Danger zone deactivate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a "Deactivate my account" button', async () => {
    mockApi();
    renderScreen(
      <AuthProvider>
        <Account />
      </AuthProvider>,
      { initialEntries: ['/account'] },
    );
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /deactivate my account/i }),
      ).toBeInTheDocument();
    });
  });

  it('opens a confirm dialog and calls the deactivate endpoint on confirm', async () => {
    const deactivateSpy = vi.fn(() =>
      new Response(
        JSON.stringify(mockOk({ ...ME.person, deletedAt: '2026-06-01T00:00:00Z' })),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    mockApi(deactivateSpy);
    const user = userEvent.setup();
    renderScreen(
      <AuthProvider>
        <Account />
      </AuthProvider>,
      { initialEntries: ['/account'] },
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /deactivate my account/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /deactivate my account/i }));
    // The confirm dialog appears with its own Deactivate action.
    const confirmBtn = await screen.findByRole('button', { name: /^deactivate$/i });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(deactivateSpy).toHaveBeenCalled();
    });
  });
});
