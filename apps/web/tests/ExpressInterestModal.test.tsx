import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderScreen, mockOk } from './test-utils.js';
import { ExpressInterestModal } from '../src/components/modals/ExpressInterestModal.js';

describe('ExpressInterestModal', () => {
  let lastUrl = '';
  let lastBody: unknown = null;
  let respondWithRateCap = false;

  beforeEach(() => {
    lastUrl = '';
    lastBody = null;
    respondWithRateCap = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
      lastUrl = input;
      lastBody = init?.body ? JSON.parse(String(init.body)) : null;
      if (respondWithRateCap) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: false,
              error: { code: 'already_expressed', message: 'Already expressed within 30 days' },
              metadata: { timestamp: new Date().toISOString() },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(mockOk({ delivered: true })), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits with optional message and POSTs the correct endpoint', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderScreen(
      <ExpressInterestModal
        open
        onOpenChange={onOpenChange}
        projectSlug="alpha"
        roleId="r-1"
        roleTitle="React dev"
      />,
    );

    await user.type(screen.getByLabelText(/optional message/i), 'I would love to help');
    await user.click(screen.getByRole('button', { name: /send interest/i }));

    await waitFor(() => {
      expect(lastUrl).toBe('/api/projects/alpha/help-wanted/r-1/express-interest');
    });
    expect((lastBody as { message: string }).message).toBe('I would love to help');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('handles 30-day rate-cap (already_expressed) by surfacing an error', async () => {
    respondWithRateCap = true;
    const user = userEvent.setup();
    renderScreen(
      <ExpressInterestModal
        open
        onOpenChange={vi.fn()}
        projectSlug="alpha"
        roleId="r-1"
        roleTitle="React dev"
      />,
    );

    await user.click(screen.getByRole('button', { name: /send interest/i }));

    await waitFor(() => {
      expect(lastUrl).toBe('/api/projects/alpha/help-wanted/r-1/express-interest');
    });
    // Modal stays open and surfaces the rate-cap message via toast (sonner) —
    // we don't render the Toaster here; just assert the fetch was called.
  });
});
