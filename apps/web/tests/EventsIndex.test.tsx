import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router';
import { renderScreen, mockPaginated } from './test-utils.js';
import { EventsIndex } from '../src/screens/EventsIndex.js';
import { AuthProvider } from '../src/hooks/useAuth.js';
import { STAFF_ME, USER_ME, json, makeSummary } from './event-fixtures.js';

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
    expect(screen.getByRole('button', { name: 'Copy feed URL' })).toBeInTheDocument();

    // Add to calendar: on scheduled upcoming cards only, never the cancelled one.
    expect(screen.getByRole('button', { name: 'Add Online Thing to calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Cancelled One to calendar' })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add Code for Philly Hack Night to calendar' }));
    const google = await screen.findByRole('menuitem', { name: 'Google Calendar' });
    // Cards hold no description, so the details are the canonical URL alone.
    expect(new URL(google.getAttribute('href')!).searchParams.get('details')).toMatch(
      /\/events\/2099-11-03-hack-night$/,
    );
    expect(screen.getByRole('menuitem', { name: 'Outlook.com' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Apple Calendar / .ics' })).toHaveAttribute(
      'href',
      '/api/events/2099-11-03-hack-night/ics',
    );
    // The icon trigger is narrow; the menu sizes to its labels instead.
    expect(screen.getByRole('menu')).toHaveClass('w-auto');
    await user.keyboard('{Escape}');

    // Anonymous: no New event
    expect(screen.queryByRole('link', { name: 'New event' })).not.toBeInTheDocument();
  });

  it('offers a signed-in member both feeds, each with a copy fallback', async () => {
    mockFetch({ me: USER_ME, upcoming: [makeSummary()] });
    render('/events');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Subscribe to calendar' }));
    expect((await screen.findByRole('menuitem', { name: 'Subscribe to all events' })).getAttribute('href')).toMatch(
      /^webcal:\/\/.+\/api\/events\/feed\.ics$/,
    );
    expect(screen.getByRole('menuitem', { name: 'Subscribe to events I’m going to' }).getAttribute('href')).toMatch(
      /^webcal:\/\/.+\/api\/events\/feed\.ics\?attendee=member$/,
    );
    expect(screen.getByRole('menuitem', { name: 'Copy all-events feed URL' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy my feed URL' })).toBeInTheDocument();
    // Sized to its labels, not the trigger, so "Subscribe to events I'm going to" doesn't wrap.
    expect(screen.getByRole('menu')).toHaveClass('w-auto');
  });

  it('leaves past cards without an Add to calendar control', async () => {
    mockFetch({
      past: [makeSummary({ startsAt: '2020-11-03T23:00:00Z', endsAt: '2020-11-04T01:30:00Z' })],
    });
    render('/events/past');
    expect(await screen.findByRole('link', { name: 'Code for Philly Hack Night' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /to calendar$/ })).not.toBeInTheDocument();
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
