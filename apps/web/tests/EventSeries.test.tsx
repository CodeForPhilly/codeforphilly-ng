import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router';
import { renderScreen, mockOk } from './test-utils.js';
import { EventSeries } from '../src/screens/EventSeries.js';
import { AuthProvider } from '../src/hooks/useAuth.js';
import type { EventSeriesDetail } from '../src/lib/api.js';
import { STAFF_ME, json, makeSeries, makeSummary } from './event-fixtures.js';

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockFetch(opts: { me?: unknown; series?: EventSeriesDetail; deleteStatus?: number }) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: input, method, body: init?.body as string | undefined });
    if (input.startsWith('/api/auth/me')) {
      return opts.me ? json(opts.me) : Promise.resolve(new Response(null, { status: 401 }));
    }
    if (opts.series && input === `/api/event-series/${opts.series.slug}`) {
      if (method === 'DELETE') return Promise.resolve(new Response(null, { status: opts.deleteStatus ?? 204 }));
      if (method === 'PATCH') {
        const patch = JSON.parse(init!.body as string) as Partial<EventSeriesDetail>;
        return json(mockOk({ ...opts.series, ...patch }));
      }
      return json(mockOk(opts.series));
    }
    return json({ success: false, error: { code: 'not_found', message: 'Not found' } }, 404);
  }) as typeof fetch);
  return calls;
}

function render(slug = 'monthly-hack-nights') {
  return renderScreen(
    <AuthProvider>
      <Routes>
        <Route path="/events/series/:slug" element={<EventSeries />} />
        <Route path="/events" element={<p>events index</p>} />
      </Routes>
    </AuthProvider>,
    { initialEntries: [`/events/series/${slug}`] },
  );
}

describe('EventSeries', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders eyebrow, title, description, breadcrumb, and upcoming/past cards', async () => {
    mockFetch({
      series: makeSeries({
        upcoming: [makeSummary({ id: 'u1', slug: 'next-one', title: 'November Hack Night' })],
        past: [
          makeSummary({
            id: 'p1',
            slug: 'old-one',
            title: 'October Hack Night',
            startsAt: '2020-10-06T22:00:00Z',
            endsAt: '2020-10-07T00:30:00Z',
          }),
        ],
      }),
    });
    render();

    expect(await screen.findByRole('heading', { level: 1, name: 'Monthly Hack Nights' })).toBeInTheDocument();
    expect(screen.getByText('Event series')).toBeInTheDocument();
    expect(screen.getByText('First Tuesday of every month.')).toBeInTheDocument();

    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Events' })).toHaveAttribute('href', '/events');
    expect(crumbs.getByText('Monthly Hack Nights')).toHaveAttribute('aria-current', 'page');

    const upcoming = screen.getByRole('heading', { name: 'Upcoming' }).closest('section')!;
    expect(within(upcoming).getByRole('link', { name: 'November Hack Night' })).toHaveAttribute(
      'href',
      '/events/next-one',
    );
    const past = screen.getByRole('heading', { name: 'Past' }).closest('section')!;
    expect(within(past).getByRole('link', { name: 'October Hack Night' })).toBeInTheDocument();

    // Staff controls hidden for anonymous viewers.
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New event in this series' })).not.toBeInTheDocument();
  });

  it('empty upcoming shows the empty copy; Past is omitted when empty', async () => {
    mockFetch({ series: makeSeries() });
    render();
    expect(await screen.findByText('Nothing scheduled yet in this series.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Past' })).not.toBeInTheDocument();
  });

  it('unknown slug renders not found', async () => {
    mockFetch({});
    render('nope');
    expect(await screen.findByRole('heading', { name: 'Series not found' })).toBeInTheDocument();
  });

  it('staff: New event link, Delete disabled with tooltip when the series has events', async () => {
    mockFetch({
      me: STAFF_ME,
      series: makeSeries({
        upcoming: [makeSummary()],
        permissions: { canEdit: true, canDelete: false },
      }),
    });
    render();

    expect(await screen.findByRole('link', { name: 'New event in this series' })).toHaveAttribute(
      'href',
      '/events/new?series=monthly-hack-nights',
    );
    const del = screen.getByRole('button', { name: 'Delete' });
    // Radix tooltips need ResizeObserver, which jsdom lacks; the tooltip
    // trigger wraps the disabled button so it stays focusable.
    expect(del).toBeDisabled();
    expect(del.parentElement).toHaveAttribute('tabindex', '0');
  });

  it('staff can edit the title in the dialog', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ me: STAFF_ME, series: makeSeries({ permissions: { canEdit: true, canDelete: true } }) });
    render();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Hack Nights');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PATCH')!.body!)).toEqual({ title: 'Hack Nights' });
  });

  it('staff can delete an empty series and land on /events', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ me: STAFF_ME, series: makeSeries({ permissions: { canEdit: true, canDelete: true } }) });
    render();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete series' }));
    expect(await screen.findByText('events index')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/event-series/monthly-hack-nights')).toBe(true);
  });
});
