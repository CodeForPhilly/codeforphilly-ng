import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { renderWithRouter, mockPaginated } from './test-utils.js';
import { SearchBox } from '../src/components/SearchBox.js';
import { NetworkErrorProvider } from '../src/components/NetworkErrorBanner.js';

/** Surfaces the router location so we can assert on in-SPA navigation. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

function Wrapped() {
  return (
    <NetworkErrorProvider>
      <SearchBox />
      <LocationProbe />
    </NetworkErrorProvider>
  );
}

/** Type a query and wait for the debounced results to land. */
async function openWithResults(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole('combobox', { name: 'Search the site' });
  await user.type(input, 'react');
  await waitFor(
    () => {
      // 3 results + the trailing "See all results" option
      expect(screen.getAllByRole('option')).toHaveLength(4);
    },
    { timeout: 3000 },
  );
  return input;
}

describe('SearchBox', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
      if (input.startsWith('/api/projects')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([{ slug: 'p1', title: 'Project One' }])), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (input.startsWith('/api/people')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockPaginated([{ slug: 'm1', fullName: 'Member One' }])), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (input.startsWith('/api/tags')) {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              mockPaginated([
                { slug: 'react', namespace: 'tech', handle: 'tech.react', title: 'React' },
              ]),
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the APG combobox attributes', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);

    const input = screen.getByRole('combobox', { name: 'Search the site' });
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');

    await openWithResults(user);

    expect(input).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox', { name: 'Search results' });
    expect(input).toHaveAttribute('aria-controls', listbox.id);
  }, 20000);

  it('owns only groups and options inside the listbox', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);
    await openWithResults(user);

    // Group headers are exposed as labelled groups, not stray divs.
    expect(screen.getByRole('group', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Members' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Tags' })).toBeInTheDocument();

    // The status region sits outside the listbox.
    const listbox = screen.getByRole('listbox', { name: 'Search results' });
    for (const child of Array.from(listbox.children)) {
      expect(['group', 'option']).toContain(child.getAttribute('role'));
    }
  }, 20000);

  it('moves aria-activedescendant with ArrowDown and navigates on Enter', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);
    const input = await openWithResults(user);

    await user.keyboard('{ArrowDown}');

    const options = screen.getAllByRole('option');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');

    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[1]!.id);

    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1');
    });
  }, 20000);

  it('wraps from the last option back to the first', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);
    const input = await openWithResults(user);

    const options = screen.getAllByRole('option');
    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', options[3]!.id);

    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
  }, 20000);

  it('closes the popup on Escape', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);
    const input = await openWithResults(user);

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  }, 20000);

  it('falls back to the all-results route when no option is active', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Wrapped />);
    await openWithResults(user);

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/projects?q=react');
    });
  }, 20000);
});
