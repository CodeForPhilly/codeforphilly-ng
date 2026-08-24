import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { renderScreen, mockPaginated } from './test-utils.js';
import { TagPicker } from '../src/components/TagPicker.js';

const TAGS = [
  {
    id: 't1',
    handle: 'topic.civic-tech',
    namespace: 'topic',
    slug: 'civic-tech',
    title: 'Civic Tech',
    projectCount: 3,
    personCount: 2,
    helpWantedCount: 0,
  },
  {
    id: 't2',
    handle: 'topic.housing',
    namespace: 'topic',
    slug: 'housing',
    title: 'Housing',
    projectCount: 1,
    personCount: 0,
    helpWantedCount: 0,
  },
];

/** Drives TagPicker as a real consumer would — controlled `value`. */
function Harness({ allowCreate = false }: { allowCreate?: boolean }) {
  const [value, setValue] = useState<string[]>([]);
  return (
    <TagPicker
      namespace="topic"
      label="Topics"
      value={value}
      onChange={setValue}
      allowCreate={allowCreate}
    />
  );
}

async function findCombobox() {
  return waitFor(() => screen.getByRole('combobox', { name: 'Topics' }));
}

describe('TagPicker', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/tags')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated(TAGS)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('associates its label with the combobox input', async () => {
    renderScreen(<Harness />);

    // getByLabelText only resolves if <Label htmlFor> points at the input id.
    const input = await waitFor(() => screen.getByLabelText('Topics'));
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  }, 20000);

  it('selects the active option with ArrowDown + Enter', async () => {
    const user = userEvent.setup();
    renderScreen(<Harness />);

    const input = await findCombobox();
    await user.click(input);

    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(2);
    });
    expect(input).toHaveAttribute('aria-expanded', 'true');

    const options = screen.getAllByRole('option');
    expect(input).not.toHaveAttribute('aria-activedescendant');

    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[1]!.id);

    await user.keyboard('{Enter}');

    // The selected tag becomes a removable chip using the house idiom.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove housing' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  }, 20000);

  it('closes the listbox on Escape', async () => {
    const user = userEvent.setup();
    renderScreen(<Harness />);

    const input = await findCombobox();
    await user.click(input);

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    expect(input).toHaveAttribute('aria-expanded', 'false');
  }, 20000);

  it('still offers the create branch as a keyboard-reachable option', async () => {
    const user = userEvent.setup();
    renderScreen(<Harness allowCreate />);

    const input = await findCombobox();
    await user.type(input, 'brand-new');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Create new tag/ })).toBeInTheDocument();
    });

    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove brand-new' })).toBeInTheDocument();
    });
  }, 20000);

  it('removes the last tag on Backspace in an empty input', async () => {
    const user = userEvent.setup();
    renderScreen(<Harness />);

    const input = await findCombobox();
    await user.click(input);
    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(2);
    });
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove civic-tech' })).toBeInTheDocument();
    });

    await user.click(input);
    await user.keyboard('{Backspace}');

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Remove civic-tech' }),
      ).not.toBeInTheDocument();
    });
  }, 20000);
});
