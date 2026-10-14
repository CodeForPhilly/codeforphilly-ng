import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router';
import { renderScreen, mockOk } from './test-utils.js';
import { EventEdit } from '../src/screens/EventEdit.js';
import { AuthProvider } from '../src/hooks/useAuth.js';
import { STAFF_ME, USER_ME, json, makeAgendaItem, makeEvent, makeSeries } from './event-fixtures.js';

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockFetch(me: unknown) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: input, method, body: init?.body as string | undefined });
    if (input.startsWith('/api/auth/me')) return json(me);
    if (input === '/api/event-series' && method === 'POST') {
      const body = JSON.parse(init!.body as string) as { title: string };
      return json(mockOk(makeSeries({ slug: body.title.toLowerCase(), title: body.title })), 201);
    }
    if (input.startsWith('/api/event-series?')) {
      return json({ success: true, data: [makeSeries()], metadata: {} });
    }
    if (input === '/api/event-series/monthly-hack-nights') return json(mockOk(makeSeries()));
    if (input === '/api/events' && method === 'POST') return json(mockOk(makeEvent({ slug: 'created' })), 201);
    if (input.startsWith('/api/events/2099-11-03-hack-night')) {
      return json(
        mockOk(
          makeEvent({
            // Oct 6 2099, 6 PM EDT → duplicate lands Nov 6, 6 PM EST
            startsAt: '2099-10-06T22:00:00Z',
            endsAt: '2099-10-07T00:30:00Z',
            series: { slug: 'monthly-hack-nights', title: 'Monthly Hack Nights' },
            agenda: [
              // 6:30–7 PM EDT on Oct 6 → 6:30–7 PM EST on Nov 6
              makeAgendaItem({
                startsAt: '2099-10-06T22:30:00Z',
                endsAt: '2099-10-06T23:00:00Z',
                title: 'Pitches',
                venueName: 'Back room',
              }),
            ],
          }),
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch);
  return calls;
}

function render(path: string, mode: 'create' | 'edit' = 'create') {
  return renderScreen(
    <AuthProvider>
      <Routes>
        <Route path="/events/new" element={<EventEdit mode="create" />} />
        <Route path="/events/:slug/edit" element={<EventEdit mode={mode} />} />
        <Route path="/events/:slug" element={<p>detail page</p>} />
      </Routes>
    </AuthProvider>,
    { initialEntries: [path] },
  );
}

describe('EventEdit', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders 403 for non-staff', async () => {
    mockFetch(USER_ME);
    render('/events/new');
    expect(await screen.findByRole('heading', { name: /Not authorized/ })).toBeInTheDocument();
  });

  it('defaults Ends to Starts + 2h30 and posts UTC times', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(STAFF_ME);
    render('/events/new');

    await user.type(await screen.findByLabelText('Title'), 'Hack Night');
    // jsdom date/time inputs accept typed ISO values
    await user.type(screen.getByLabelText('Start date'), '2099-11-03');
    await user.type(screen.getByLabelText('Start time'), '22:00');

    expect(screen.getByLabelText('End date')).toHaveValue('2099-11-04');
    expect(screen.getByLabelText('End time')).toHaveValue('00:30');

    // Breadcrumb
    expect(screen.getByText('New event', { selector: '[aria-current="page"]' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === 'POST')!.body!) as Record<string, unknown>;
    expect(body['startsAt']).toBe('2099-11-04T03:00:00Z');
    expect(body['endsAt']).toBe('2099-11-04T05:30:00Z');
    expect(body['status']).toBe('scheduled');
    expect(body).not.toHaveProperty('slug');
    expect(await screen.findByText('detail page')).toBeInTheDocument();
  });

  it('duplicate mode prefills from the source shifted one month, with a note', async () => {
    mockFetch(STAFF_ME);
    render('/events/new?from=2099-11-03-hack-night');

    expect(await screen.findByText('Copied from Code for Philly Hack Night. Check the date.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Code for Philly Hack Night');
    expect(screen.getByLabelText('Start date')).toHaveValue('2099-11-06');
    expect(screen.getByLabelText('Start time')).toHaveValue('18:00');
    expect(screen.getByLabelText('End time')).toHaveValue('20:30');
    expect(screen.getByLabelText('Slug')).toHaveValue('');
  });

  it('edit mode shows "Save and notify" when the time changes on an event with RSVPs', async () => {
    const user = userEvent.setup();
    mockFetch(STAFF_ME);
    render('/events/2099-11-03-hack-night/edit', 'edit');

    const startTime = await screen.findByLabelText('Start time');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    await user.clear(startTime);
    await user.type(startTime, '19:00');
    expect(screen.getByRole('button', { name: 'Save and notify 14 attendees' })).toBeInTheDocument();
    expect(screen.getByText(/Changing this redirects the old link for 90 days/)).toBeInTheDocument();
  });

  it('flags an agenda row that starts outside the event and does not save', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(STAFF_ME);
    render('/events/new');

    await user.type(await screen.findByLabelText('Title'), 'Launchpad weekend');
    await user.type(screen.getByLabelText('Start date'), '2099-11-03');
    await user.type(screen.getByLabelText('Start time'), '18:00');
    await user.click(screen.getByText('Add a schedule'));
    await user.click(screen.getByRole('button', { name: 'Add schedule item' }));
    // The new row starts on the event's date; push it two days out.
    expect(screen.getByLabelText('Item 1 start date')).toHaveValue('2099-11-03');
    await user.clear(screen.getByLabelText('Item 1 start date'));
    await user.type(screen.getByLabelText('Item 1 start date'), '2099-11-05');
    await user.type(screen.getByLabelText('Item 1 start time'), '10:00');
    await user.type(screen.getByLabelText('Item 1 title'), 'Demos');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Must start within the event’s start and end.')).toBeInTheDocument();
    expect(screen.getByLabelText('Item 1 start time')).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates a new series inline before posting the event', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(STAFF_ME);
    render('/events/new');

    await user.type(await screen.findByLabelText('Title'), 'Launchpad kickoff');
    await user.type(screen.getByLabelText('Start date'), '2099-11-03');
    await user.type(screen.getByLabelText('Start time'), '18:00');
    const series = screen.getByRole('combobox', { name: 'Series' });
    await user.type(series, 'Launchpad');
    await user.click(await screen.findByRole('option', { name: 'Create “Launchpad”' }));
    expect(screen.getByText('A new series “Launchpad” will be created when you save.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/events' && c.method === 'POST')).toBe(true));
    const seriesPost = calls.findIndex((c) => c.url === '/api/event-series' && c.method === 'POST');
    const eventPost = calls.findIndex((c) => c.url === '/api/events' && c.method === 'POST');
    expect(seriesPost).toBeGreaterThan(-1);
    expect(seriesPost).toBeLessThan(eventPost);
    expect(JSON.parse(calls[seriesPost]!.body!)).toEqual({ title: 'Launchpad' });
    expect(JSON.parse(calls[eventPost]!.body!)).toMatchObject({ seriesSlug: 'launchpad' });
  });

  it('picks an existing series without creating one', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(STAFF_ME);
    render('/events/new');

    await user.type(await screen.findByLabelText('Title'), 'Hack Night');
    await user.type(screen.getByLabelText('Start date'), '2099-11-03');
    await user.type(screen.getByLabelText('Start time'), '18:00');
    await user.type(screen.getByRole('combobox', { name: 'Series' }), 'monthly');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('combobox', { name: 'Series' })).toHaveValue('Monthly Hack Nights');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/events' && c.method === 'POST')).toBe(true));
    expect(calls.some((c) => c.url === '/api/event-series' && c.method === 'POST')).toBe(false);
    const body = JSON.parse(calls.find((c) => c.url === '/api/events')!.body!) as Record<string, unknown>;
    expect(body['seriesSlug']).toBe('monthly-hack-nights');
  });

  it('?series= preselects the series', async () => {
    mockFetch(STAFF_ME);
    render('/events/new?series=monthly-hack-nights');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Series' })).toHaveValue('Monthly Hack Nights'),
    );
  });

  it('duplicate mode carries the series and shifts agenda rows one month', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(STAFF_ME);
    render('/events/new?from=2099-11-03-hack-night');

    await screen.findByText('Copied from Code for Philly Hack Night. Check the date.');
    expect(screen.getByRole('combobox', { name: 'Series' })).toHaveValue('Monthly Hack Nights');
    expect(screen.getByText('Schedule (1)')).toBeInTheDocument();
    expect(screen.getByLabelText('Item 1 start date')).toHaveValue('2099-11-06');
    expect(screen.getByLabelText('Item 1 start time')).toHaveValue('18:30');
    expect(screen.getByLabelText('Item 1 end time')).toHaveValue('19:00');
    expect(screen.getByLabelText('Item 1 title')).toHaveValue('Pitches');
    expect(screen.getByLabelText('Item 1 venue')).toHaveValue('Back room');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/events' && c.method === 'POST')).toBe(true));
    const body = JSON.parse(calls.find((c) => c.url === '/api/events')!.body!) as Record<string, unknown>;
    expect(body['seriesSlug']).toBe('monthly-hack-nights');
    expect(body['agenda']).toEqual([
      {
        startsAt: '2099-11-06T23:30:00Z',
        endsAt: '2099-11-07T00:00:00Z',
        title: 'Pitches',
        venueName: 'Back room',
        venueAddress: null,
        description: null,
      },
    ]);
  });
});
