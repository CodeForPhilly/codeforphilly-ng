import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworkErrorProvider, useNetworkError } from '../src/components/NetworkErrorBanner.js';

function Trigger({ retry }: { retry?: () => void }) {
  const { showError } = useNetworkError();
  return (
    <button type="button" onClick={() => showError('Something broke.', retry)}>
      Break
    </button>
  );
}

describe('NetworkErrorBanner', () => {
  it('offers Retry that re-runs the failed work and dismisses', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(
      <NetworkErrorProvider>
        <Trigger retry={retry} />
      </NetworkErrorProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Break' }));
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Something broke.');

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads Dismiss when there is nothing to retry', async () => {
    const user = userEvent.setup();
    render(
      <NetworkErrorProvider>
        <Trigger />
      </NetworkErrorProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Break' }));
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
