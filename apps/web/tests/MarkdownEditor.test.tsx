import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from './test-utils.js';
import { MarkdownEditor } from '../src/components/MarkdownEditor.js';

function Harness() {
  return <MarkdownEditor label="Overview" value="" onChange={() => {}} />;
}

describe('MarkdownEditor formatting toolbar', () => {
  beforeEach(() => {
    // The preview round-trip is skipped for empty content, but stub fetch
    // anyway so a stray call can never reach the network.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes a labelled toolbar whose buttons have real names', () => {
    renderWithRouter(<Harness />);
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    for (const name of ['Bold', 'Italic', 'Insert link', 'Bulleted list', 'Code', 'Quote']) {
      expect(within(toolbar).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('keeps every accessible name a superset of the visible label (SC 2.5.3)', () => {
    renderWithRouter(<Harness />);
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    for (const [visible, name] of [
      ['B', 'Bold'],
      ['I', 'Italic'],
      ['Link', 'Insert link'],
      ['List', 'Bulleted list'],
    ] as const) {
      const btn = within(toolbar).getByRole('button', { name });
      expect(btn.textContent).toBe(visible);
      expect(btn.getAttribute('aria-label')?.toLowerCase()).toContain(visible.toLowerCase());
    }
  });

  it('is a single tab stop with a roving tabindex', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    const buttons = within(toolbar).getAllByRole('button');

    // Only the active button is reachable by Tab.
    expect(buttons.filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('tabindex', '0');

    buttons[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(buttons[1]).toHaveFocus();
    expect(buttons[1]).toHaveAttribute('tabindex', '0');
    expect(buttons[0]).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{End}');
    expect(buttons[buttons.length - 1]).toHaveFocus();

    // Wraps forward off the end, and Home returns to the first.
    await user.keyboard('{ArrowRight}');
    expect(buttons[0]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(buttons[buttons.length - 1]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(buttons[0]).toHaveFocus();
  });
});
