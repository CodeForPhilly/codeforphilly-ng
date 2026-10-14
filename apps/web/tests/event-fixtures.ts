import type { EventAgendaItem, EventDetail, EventRsvp, EventSeriesDetail, EventSummary } from '../src/lib/api.js';

export const STAFF_ME = {
  data: {
    person: { id: 's1', slug: 'staffer', fullName: 'Staff Person', avatarUrl: null, accountLevel: 'staff' },
    hasGitHubLink: true,
  },
};
export const USER_ME = {
  data: {
    person: { id: 'u1', slug: 'member', fullName: 'Member Person', avatarUrl: null, accountLevel: 'user' },
    hasGitHubLink: true,
  },
};

export function makeSummary(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: 'e1',
    slug: '2099-11-03-hack-night',
    title: 'Code for Philly Hack Night',
    // 6:00–8:30 PM EST
    startsAt: '2099-11-03T23:00:00Z',
    endsAt: '2099-11-04T01:30:00Z',
    venueName: 'Indy Hall',
    venueAddress: '709 N 2nd St, Philadelphia, PA 19123',
    onlineUrl: null,
    meetupUrl: null,
    series: null,
    status: 'scheduled',
    cancelledAt: null,
    rsvpCount: 14,
    viewerRsvp: null,
    icsUrl: '/api/events/2099-11-03-hack-night/ics',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    ...makeSummary(),
    viewerRecentProjects: [],
    recentProjects: [],
    description: 'Bring a laptop.',
    descriptionHtml: '<p>Bring a laptop.</p>',
    cancellationNote: null,
    agenda: [],
    permissions: { canRsvp: false, canEdit: false, canPublish: false, canCancel: false, canDelete: false },
    ...overrides,
  };
}

export function makeRsvp(name: string, overrides: Partial<EventRsvp> = {}): EventRsvp {
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  return {
    person: { slug, fullName: name, avatarUrl: null },
    plan: null,
    project: null,
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    ...overrides,
  };
}

export function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

export function makeAgendaItem(overrides: Partial<EventAgendaItem> = {}): EventAgendaItem {
  return {
    startsAt: '2099-11-03T23:00:00Z',
    endsAt: null,
    title: 'Agenda item',
    venueName: null,
    venueAddress: null,
    description: null,
    descriptionHtml: null,
    ...overrides,
  };
}

export function makeSeries(overrides: Partial<EventSeriesDetail> = {}): EventSeriesDetail {
  return {
    id: 's-1',
    slug: 'monthly-hack-nights',
    title: 'Monthly Hack Nights',
    description: 'First Tuesday of every month.',
    descriptionHtml: '<p>First Tuesday of every month.</p>',
    upcoming: [],
    past: [],
    permissions: { canEdit: false, canDelete: false },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}
