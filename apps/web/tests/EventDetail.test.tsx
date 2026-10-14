import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router';
import { renderScreen, mockOk } from './test-utils.js';
import { EventDetail } from '../src/screens/EventDetail.js';
import { AuthProvider } from '../src/hooks/useAuth.js';
import type { EventDetail as EventData, EventRsvp } from '../src/lib/api.js';
import { STAFF_ME, USER_ME, json, makeAgendaItem, makeEvent, makeRsvp } from './event-fixtures.js';

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockFetch(opts: { me?: unknown; event: EventData; rsvps?: EventRsvp[]; rsvpResponse?: () => Promise<Response> }) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: input, method, body: init?.body as string | undefined });
    if (input.startsWith('/api/auth/me')) {
      return opts.me ? json(opts.me) : Promise.resolve(new Response(null, { status: 401 }));
    }
    if (input.includes('/rsvps')) return json(mockOk(opts.rsvps ?? []));
    if (input.endsWith('/rsvp') && method === 'PUT') {
      if (opts.rsvpResponse) return opts.rsvpResponse();
      const body = JSON.parse((init?.body as string) || '{}') as { plan?: string };
      return json(
        mockOk({
          rsvp: makeRsvp('Member Person', { plan: (body.plan ?? null) as EventRsvp['plan'] }),
          rsvpCount: opts.event.rsvpCount + 1,
          confirmationDelivered: true,
        }),
        201,
      );
    }
    if (input.startsWith('/api/projects')) {
      return json({ success: true, data: [{ slug: 'squadquest', title: 'SquadQuest' }], metadata: {} });
    }
    if (input.startsWith(`/api/events/${opts.event.slug}`)) return json(mockOk(opts.event));
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch);
  return calls;
}

function render(slug = '2099-11-03-hack-night') {
  return renderScreen(
    <AuthProvider>
      <Routes>
        <Route path="/events/:slug" element={<EventDetail />} />
      </Routes>
    </AuthProvider>,
    { initialEntries: [`/events/${slug}`] },
  );
}

describe('EventDetail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders an event with no description and omits the About section', async () => {
    mockFetch({ event: makeEvent({ description: null, descriptionHtml: '' }) });
    render();

    expect(await screen.findByRole('heading', { name: 'Code for Philly Hack Night', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'About' })).not.toBeInTheDocument();
  });

  it('renders header, breadcrumb, and "Sign in to RSVP" for anonymous', async () => {
    mockFetch({ event: makeEvent({ meetupUrl: 'https://www.meetup.com/x/events/1/' }) });
    render();

    expect(await screen.findByRole('heading', { name: 'Code for Philly Hack Night', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Tuesday, November 3, 2099 · 6:00–8:30 PM EST')).toBeInTheDocument();
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Events' })).toHaveAttribute('href', '/events');

    const signIn = screen.getByRole('link', { name: 'Sign in to RSVP' });
    expect(signIn.getAttribute('href')).toBe(`/login?return=${encodeURIComponent('/events/2099-11-03-hack-night')}`);
    expect(screen.getByText('Your name will appear on the attendee list.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /I’m going/ })).not.toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Add to Google Calendar' }).getAttribute('href')).toMatch(
      /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/,
    );
    expect(screen.getByRole('link', { name: 'Download .ics' })).toHaveAttribute(
      'href',
      '/api/events/2099-11-03-hack-night/ics',
    );
    expect(screen.getByRole('link', { name: 'Also listed on Meetup ↗' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^709 N 2nd St/ }).getAttribute('href')).toContain(
      'https://maps.google.com/?q=',
    );
    // No staff controls
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('signed in, not going: "I\'m going" PUTs, flips optimistically, then shows the follow-up', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ me: USER_ME, event: makeEvent({ permissions: { canRsvp: true, canEdit: false, canPublish: false, canCancel: false, canDelete: false } }) });
    render();

    const btn = await screen.findByRole('button', { name: 'I’m going' });
    await user.click(btn);

    expect(await screen.findByText('You’re going ✓')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/api/events/2099-11-03-hack-night/rsvp');
    expect(put?.body).toBe('{}');
    expect(await screen.findByText('15 going')).toBeInTheDocument();

    // Follow-up: three choices, nothing selected
    expect(screen.getByText('What are you coming to do? (optional)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I’m new to Code for Philly' }));
    await waitFor(() => {
      const followUp = calls.filter((c) => c.method === 'PUT')[1];
      expect(followUp?.body).toBe(JSON.stringify({ plan: 'newcomer' }));
    });
    expect(await screen.findByText('I’m new to Code for Philly')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('going with an answered follow-up shows the selected choice and "Can\'t make it?"', async () => {
    mockFetch({
      me: USER_ME,
      event: makeEvent({
        viewerRsvp: { plan: 'project', project: { slug: 'squadquest', title: 'SquadQuest' }, createdAt: '2026-10-02T00:00:00Z' },
      }),
    });
    render();
    expect(await screen.findByText('You’re going ✓')).toBeInTheDocument();
    expect(screen.getByText('I’m coming to work on SquadQuest')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Can’t make it?' })).toBeInTheDocument();
  });

  it('cancelled: banner with note, no RSVP control, "Had planned to go" heading', async () => {
    mockFetch({
      me: USER_ME,
      event: makeEvent({ status: 'cancelled', cancellationNote: 'Venue closed.' }),
    });
    render();
    expect(await screen.findByText('This event has been cancelled.')).toBeInTheDocument();
    expect(screen.getByText('Venue closed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'I’m going' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in to RSVP' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Had planned to go (14)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '14 going' })).toBeInTheDocument();
  });

  it('groups attendees: projects by count, then newcomers, looking, not sure', async () => {
    mockFetch({
      event: makeEvent({ rsvpCount: 6 }),
      rsvps: [
        makeRsvp('Ann', { plan: 'project', project: { slug: 'alpha', title: 'Alpha' } }),
        makeRsvp('Bob', { plan: 'project', project: { slug: 'zeta', title: 'Zeta' } }),
        makeRsvp('Cat', { plan: 'project', project: { slug: 'zeta', title: 'Zeta' } }),
        makeRsvp('Dan', { plan: 'newcomer' }),
        makeRsvp('Eve', { plan: 'no_project' }),
        makeRsvp('Fay'),
      ],
    });
    render();
    const section = await screen.findByRole('heading', { name: 'Going (6)' });
    const attendees = section.parentElement!;
    await within(attendees).findByRole('heading', { name: 'Zeta' });
    const headings = within(attendees)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Zeta', 'Alpha', 'New to Code for Philly', 'Looking for a project', 'Not sure yet']);
    expect(within(attendees).getByRole('link', { name: 'Zeta' })).toHaveAttribute('href', '/projects/zeta');
  });

  it('no subheadings when nobody answered; empty state when nobody RSVPd', async () => {
    mockFetch({ event: makeEvent({ rsvpCount: 0 }), rsvps: [] });
    render();
    expect(await screen.findByText('Nobody has RSVP’d yet. Be the first!')).toBeInTheDocument();
  });

  it('staff see Edit, Duplicate, Cancel, and a disabled Delete when canDelete is false', async () => {
    mockFetch({
      me: STAFF_ME,
      event: makeEvent({
        permissions: { canRsvp: true, canEdit: true, canPublish: false, canCancel: true, canDelete: false },
      }),
    });
    render();
    expect(await screen.findByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/events/2099-11-03-hack-night/edit');
    expect(screen.getByRole('link', { name: 'Duplicate' })).toHaveAttribute('href', '/events/new?from=2099-11-03-hack-night');
    expect(screen.getByRole('button', { name: 'Cancel event…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('draft: staff banner with Publish; no calendar links', async () => {
    mockFetch({
      me: STAFF_ME,
      event: makeEvent({
        status: 'draft',
        permissions: { canRsvp: false, canEdit: true, canPublish: true, canCancel: false, canDelete: true },
      }),
    });
    render();
    expect(await screen.findByText('Draft — only staff can see this event.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add to Google Calendar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('renders series link and schedule only when present', async () => {
    mockFetch({
      event: makeEvent({
        series: { slug: 'monthly-hack-nights', title: 'Monthly Hack Nights' },
        agenda: [
          {
            startsAt: '2099-11-03T23:00:00Z',
            endsAt: '2099-11-03T23:30:00Z',
            title: 'Welcome & pitches',
            venueName: null,
            venueAddress: null,
            description: null,
            descriptionHtml: null,
          },
        ],
      }),
    });
    render();
    expect(await screen.findByRole('link', { name: 'Monthly Hack Nights' })).toHaveAttribute(
      'href',
      '/events/series/monthly-hack-nights',
    );
    expect(screen.getAllByRole('heading', { name: 'Schedule' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Welcome & pitches').length).toBeGreaterThan(0);
  });

  it('"Part of" sits above the H1 and links to the series page', async () => {
    mockFetch({ event: makeEvent({ series: { slug: 'launchpad', title: 'Launchpad' } }) });
    render();
    const link = await screen.findByRole('link', { name: 'Launchpad' });
    expect(link).toHaveAttribute('href', '/events/series/launchpad');
    expect(link.closest('p')).toHaveTextContent('Part of Launchpad');
    const h1 = screen.getByRole('heading', { level: 1 });
    // DOCUMENT_POSITION_FOLLOWING: the H1 comes after the "Part of" line.
    expect(link.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no series and no agenda: no "Part of", no Schedule, no jump link', async () => {
    mockFetch({ event: makeEvent() });
    render();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/Part of/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /See the schedule/ })).not.toBeInTheDocument();
  });

  it('groups the schedule by Philly day and shows a venue only when it changes', async () => {
    mockFetch({
      event: makeEvent({
        venueName: 'Indy Hall',
        venueAddress: '709 N 2nd St',
        // Tue Mar 31 2099 6 PM EDT → Thu Apr 2 9 PM EDT
        startsAt: '2099-03-31T22:00:00Z',
        endsAt: '2099-04-03T01:00:00Z',
        agenda: [
          makeAgendaItem({
            startsAt: '2099-03-31T22:00:00Z',
            endsAt: '2099-04-01T01:00:00Z',
            title: 'Kickoff',
          }),
          makeAgendaItem({
            startsAt: '2099-04-01T13:00:00Z',
            endsAt: '2099-04-01T23:00:00Z',
            title: 'Hacking',
            venueName: 'City Hall',
            venueAddress: '1400 JFK Blvd',
            descriptionHtml: '<p>Bring snacks.</p>',
          }),
          makeAgendaItem({
            startsAt: '2099-04-01T23:00:00Z',
            endsAt: '2099-04-02T00:30:00Z',
            title: 'Dinner',
            venueName: 'City Hall',
            venueAddress: '1400 JFK Blvd',
          }),
          makeAgendaItem({ startsAt: '2099-04-02T01:00:00Z', title: 'Back at base' }),
        ],
      }),
    });
    render();
    await screen.findByRole('heading', { level: 1 });
    // jsdom applies no CSS, so both the main-column and sidebar copies render.
    const blocks = screen.getAllByRole('heading', { name: 'Schedule' }).map((h) => h.closest('section')!);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveAttribute('id', 'schedule');
    expect(screen.getByRole('link', { name: /See the schedule/ })).toHaveAttribute('href', '#schedule');

    const block = within(blocks[0]!);
    const days = block.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(days).toEqual(['Tuesday, March 31', 'Wednesday, April 1']);
    expect(block.getByText('6–9pm')).toBeInTheDocument();
    expect(block.getByText('9am–7pm')).toBeInTheDocument();
    expect(block.getByText('7–8:30pm')).toBeInTheDocument();
    expect(block.getByText('Bring snacks.')).toBeInTheDocument();

    // Kickoff is at the event venue (no line); Hacking moves to City Hall
    // (line); Dinner stays there (suppressed); Back at base returns (line).
    const venueLinks = block.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('https://maps.google.com'));
    expect(venueLinks.map((a) => a.textContent)).toEqual(['City Hall', 'Indy Hall']);
    expect(venueLinks[0]).toHaveAttribute('href', `https://maps.google.com/?q=${encodeURIComponent('City Hall, 1400 JFK Blvd')}`);
  });

  it('past event shows the ended banner and no control', async () => {
    mockFetch({
      me: USER_ME,
      event: makeEvent({ startsAt: '2020-01-07T23:00:00Z', endsAt: '2020-01-08T01:30:00Z', rsvpCount: 0 }),
      rsvps: [],
    });
    render();
    expect(await screen.findByText('This event has ended.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'I’m going' })).not.toBeInTheDocument();
    expect(await screen.findByText('Nobody RSVP’d.')).toBeInTheDocument();
  });
});
