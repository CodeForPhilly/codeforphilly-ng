import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderScreen } from './test-utils.js';
import { LoginPlaceholder } from '../src/pages/LoginPlaceholder.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

describe('LoginPlaceholder', () => {
  beforeEach(() => {
    // Default: anonymous /api/auth/me. Tests that need a logged-in
    // state override this.
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
        <LoginPlaceholder />
      </AuthProvider>,
      { initialEntries: ['/login'] },
    );
  }

  it('renders the primary GitHub button + a collapsed password disclosure', async () => {
    render();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /sign in with github/i })).toBeInTheDocument();
    });
    // Disclosure exists but is closed — fields are not yet in the DOM
    expect(
      screen.getByRole('button', { name: /sign in with your code for philly password/i }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/username or email/i)).not.toBeInTheDocument();
  });

  it('expanding the disclosure reveals the password form', async () => {
    render();
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /sign in with your code for philly password/i }),
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole('button', { name: /sign in with your code for philly password/i }),
    );
    expect(screen.getByLabelText(/username or email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  });

  it('keeps submit disabled until both fields are filled', async () => {
    render();
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /sign in with your code for philly password/i }),
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole('button', { name: /sign in with your code for philly password/i }),
    );
    const submitBtn = screen.getByRole('button', { name: /^sign in$/i });
    expect(submitBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: 'jane' },
    });
    expect(submitBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'secret' },
    });
    expect(submitBtn).not.toBeDisabled();
  });

  it('renders inline error on 401 invalid_credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
      if (input.startsWith('/api/auth/me')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (input === '/api/auth/login' && init?.method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: false,
              error: { code: 'invalid_credentials', message: 'Invalid credentials' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);

    render();
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /sign in with your code for philly password/i }),
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole('button', { name: /sign in with your code for philly password/i }),
    );
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: 'jane' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/username or password you entered is incorrect/i),
      ).toBeInTheDocument();
    });
  });
});
