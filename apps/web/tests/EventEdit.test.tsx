import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router';
import { renderScreen, mockOk } from './test-utils.js';
import { EventEdit } from '../src/screens/EventEdit.js';
import { AuthProvider } from '../src/hooks/useAuth.js';
import { STAFF_ME, USER_ME, json, makeEvent } from './event-fixtures.js';

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
    if (input === '/api/events' && method === 'POST') return json(mockOk(makeEvent({ slug: 'created' })), 201);
    if (input.startsWith('/api/events/2099-11-03-hack-night')) {
      return json(
        mockOk(
          makeEvent({
            // Oct 6 2099, 6 PM EDT → duplicate lands Nov 6, 6 PM EST
            startsAt: '2099-10-06T22:00:00Z',
            endsAt: '2099-10-07T00:30:00Z',
            series: { slug: 'monthly-hack-nights', title: 'Monthly Hack Nights' },
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
});
