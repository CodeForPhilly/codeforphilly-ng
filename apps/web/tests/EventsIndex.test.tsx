import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { renderScreen, mockPaginated } from './test-utils.js';
import { EventsIndex } from '../src/screens/EventsIndex.js';
import { AuthProvider } from '../src/hooks/useAuth.js';
import { STAFF_ME, json, makeSummary } from './event-fixtures.js';

function mockFetch(opts: { me?: unknown; upcoming?: unknown[]; past?: unknown[] }) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
    calls.push(input);
    if (input.startsWith('/api/auth/me')) {
      return opts.me ? json(opts.me) : Promise.resolve(new Response(null, { status: 401 }));
    }
    if (input.startsWith('/api/events?') && input.includes('when=past')) return json(mockPaginated(opts.past ?? []));
    if (input.startsWith('/api/events')) return json(mockPaginated(opts.upcoming ?? []));
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch);
  return calls;
}

function render(path: string) {
  return renderScreen(
    <AuthProvider>
      <Routes>
        <Route path="/events" element={<EventsIndex />} />
        <Route path="/events/past" element={<EventsIndex />} />
      </Routes>
    </AuthProvider>,
    { initialEntries: [path] },
  );
}

describe('EventsIndex', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists upcoming events under month headings with card details', async () => {
    const calls = mockFetch({
      upcoming: [
        makeSummary(),
        makeSummary({
          id: 'e2',
          slug: 'online-thing',
          title: 'Online Thing',
          venueName: null,
          onlineUrl: 'https://meet.example',
          rsvpCount: 3,
          viewerRsvp: { plan: null, project: null, createdAt: '2026-10-01T00:00:00Z' },
        }),
        makeSummary({ id: 'e3', slug: 'cancelled-one', title: 'Cancelled One', status: 'cancelled', venueName: null, rsvpCount: 5 }),
      ],
    });
    render('/events');

    expect(screen.getByRole('heading', { name: 'Events', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'November 2099' })).toBeInTheDocument();
    expect(calls.some((c) => c.includes('when=upcoming') && c.includes('perPage=50'))).toBe(true);

    const link = screen.getByRole('link', { name: 'Code for Philly Hack Night' });
    expect(link).toHaveAttribute('href', '/events/2099-11-03-hack-night');
    expect(screen.getAllByText('6:00–8:30 PM EST').length).toBeGreaterThan(0);
    expect(screen.getByText('Indy Hall')).toBeInTheDocument();
    expect(screen.getByText('14 going')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText(/You’re going ✓/)).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Location TBA')).toBeInTheDocument();

    // No breadcrumb on /events; tabs mark Upcoming active.
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Event views' });
    expect(within(tabs).getByRole('link', { name: 'Upcoming' })).toHaveAttribute('aria-current', 'page');

    // Subscribe link uses webcal://
    expect(screen.getByRole('link', { name: 'Subscribe to calendar' }).getAttribute('href')).toMatch(
      /^webcal:\/\/.+\/api\/events\/feed\.ics$/,
    );
    // Anonymous: no New event
    expect(screen.queryByRole('link', { name: 'New event' })).not.toBeInTheDocument();
  });

  it('shows the empty state with the New event button for staff', async () => {
    mockFetch({ me: STAFF_ME, upcoming: [] });
    render('/events');
    expect(await screen.findByText(/Nothing on the calendar yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Join the Slack' })).toHaveAttribute('href', '/chat');
    // Header + empty state
    expect(await screen.findAllByRole('link', { name: 'New event' })).toHaveLength(2);
  });

  it('renders the past view with a breadcrumb and its empty state', async () => {
    const calls = mockFetch({ past: [] });
    render('/events/past');
    expect(await screen.findByText('No past events yet.')).toBeInTheDocument();
    expect(calls.some((c) => c.includes('when=past'))).toBe(true);
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Events' })).toHaveAttribute('href', '/events');
    expect(within(trail).getByText('Past')).toHaveAttribute('aria-current', 'page');
  });
});
