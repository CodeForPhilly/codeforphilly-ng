import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderScreen } from './test-utils.js';
import { PasswordResetRequest } from '../src/pages/PasswordResetRequest.js';
import { PasswordResetConfirm } from '../src/pages/PasswordResetConfirm.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

describe('PasswordResetRequest', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function render() {
    return renderScreen(
      <AuthProvider>
        <PasswordResetRequest />
      </AuthProvider>,
      { initialEntries: ['/login/forgot'] },
    );
  }

  it('renders the request form with disabled submit when empty', async () => {
    render();
    await waitFor(() => {
      expect(screen.getByLabelText(/username or email/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeDisabled();
  });

  it('shows the generic confirmation message after submit (anti-enumeration)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (input === '/api/auth/password-reset/request' && init?.method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify({ success: true, data: { delivered: true }, metadata: { timestamp: '' } }),
            { status: 202, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);

    render();
    await waitFor(() => {
      expect(screen.getByLabelText(/username or email/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/if we have an account on file matching/i),
      ).toBeInTheDocument();
    });
    // The displayed email is the value the user entered, not anything the server confirmed.
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
  });
});

describe('PasswordResetConfirm', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderWithToken(token: string | null) {
    const entry = token ? `/login/reset?token=${encodeURIComponent(token)}` : '/login/reset';
    return renderScreen(
      <AuthProvider>
        <PasswordResetConfirm />
      </AuthProvider>,
      { initialEntries: [entry] },
    );
  }

  it('warns when the URL is missing the token query param', async () => {
    renderWithToken(null);
    await waitFor(() => {
      expect(
        screen.getByText(/this reset link is missing its token/i),
      ).toBeInTheDocument();
    });
  });

  it('blocks submit when the two passwords do not match', async () => {
    renderWithToken('opaque-token');
    await waitFor(() => {
      expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/^new password$/i), {
      target: { value: 'longenough1' },
    });
    fireEvent.change(screen.getByLabelText(/^confirm new password$/i), {
      target: { value: 'different1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /set password and sign in/i }));
    await waitFor(() => {
      expect(screen.getByText(/two passwords don/i)).toBeInTheDocument();
    });
  });

  it('renders friendly invalid-token error on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (input === '/api/auth/password-reset/confirm' && init?.method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: false,
              error: { code: 'invalid_token', message: 'Invalid or expired token' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);

    renderWithToken('expired-token');
    await waitFor(() => {
      expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/^new password$/i), {
      target: { value: 'longenough1' },
    });
    fireEvent.change(screen.getByLabelText(/^confirm new password$/i), {
      target: { value: 'longenough1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /set password and sign in/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/this reset link is invalid or has expired/i),
      ).toBeInTheDocument();
    });
  });
});
