/**
 * /admin/members — event RSVPs in the roster row and the detail panel
 * (specs/screens/admin-members.md; issue #266).
 *
 * Every name here is invented; none is a real member's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { mockOk, mockPaginated, renderScreen } from './test-utils.js';
import { AdminMembers } from '../src/pages/AdminMembers.js';
import { AuthProvider } from '../src/hooks/useAuth.js';
import type { MemberDetail, MemberRow } from '../src/lib/api.js';
import { STAFF_ME, json } from './event-fixtures.js';

const NO_FOOTPRINT: MemberRow['footprint'] = {
  memberships: 0,
  updates: 0,
  buzz: 0,
  blogPosts: 0,
  helpWantedInterest: 0,
  tags: 0,
  rsvps: 0,
};

function makeRow(over: Partial<MemberRow> = {}): MemberRow {
  return {
    id: `id-${over.slug ?? 'member'}`,
    slug: 'member',
    fullName: 'Test Member',
    avatarUrl: null,
    createdAt: '2026-11-10T12:00:00Z',
    deletedAt: null,
    origin: 'signed-up',
    email: null,
    emailDomain: null,
    hasGitHubLink: false,
    github: null,
    lastLoginAt: null,
    signInCount: 1,
    lastSlackSsoAt: null,
    emailBounce: null,
    bioExcerpt: '',
    footprint: NO_FOOTPRINT,
    latestVote: null,
    stagedVote: null,
    purgeAfter: null,
    signals: [],
    attention: 0,
    ...over,
  };
}

function makeDetail(rsvps: MemberDetail['footprint']['rsvps']): MemberDetail {
  return {
    person: { slug: 'quiet-volunteer', fullName: 'Quiet Volunteer', bioHtml: '' } as unknown as MemberDetail['person'],
    footprint: { memberships: [], updates: [], buzz: [], blogPosts: [], helpWantedInterest: [], tags: [], rsvps },
    votes: [],
    earlierVotes: [],
    earlierPurges: [],
  };
}

function mockFetch(opts: { rows: MemberRow[]; details?: Record<string, MemberDetail> }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
    if (input.startsWith('/api/auth/me')) return json(STAFF_ME);
    if (input.startsWith('/api/admin/members?') || input === '/api/admin/members') {
      return json(mockPaginated(opts.rows, { perPage: 50 }));
    }
    const m = /^\/api\/admin\/members\/([^/?]+)$/.exec(input);
    if (m) {
      const d = opts.details?.[decodeURIComponent(m[1]!)];
      return d ? json(mockOk(d)) : json({ success: false, error: { code: 'not_found', message: 'Not found' } }, 404);
    }
    // The recent agent purges banner and anything else the page asks for: empty.
    if (input.startsWith('/api/admin/')) return json(mockPaginated([]));
    return json({ success: false, error: { code: 'not_found', message: 'Not found' } }, 404);
  }) as typeof fetch);
}

function render(path = '/admin/members') {
  return renderScreen(
    <AuthProvider>
      <Routes>
        <Route path="/admin/members" element={<AdminMembers />} />
        <Route path="/admin/members/:slug" element={<AdminMembers />} />
      </Routes>
    </AuthProvider>,
    { initialEntries: [path] },
  );
}

describe('AdminMembers: event RSVPs', () => {
  // The detail route selects its row, which scrolls it into view; jsdom has no layout.
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows an RSVP count on the roster row only when the member has RSVPs', async () => {
    mockFetch({
      rows: [
        makeRow({ slug: 'quiet-volunteer', fullName: 'Quiet Volunteer', footprint: { ...NO_FOOTPRINT, rsvps: 3 } }),
        makeRow({ slug: 'one-rsvp', fullName: 'One Rsvp', footprint: { ...NO_FOOTPRINT, rsvps: 1, tags: 2 } }),
        makeRow({ slug: 'empty-account', fullName: 'Empty Account' }),
      ],
    });
    render();

    const rowOf = async (name: string) => (await screen.findByRole('link', { name })).closest('li')!;
    expect(within(await rowOf('Quiet Volunteer')).getByText('0 projects · 3 RSVPs · 0 tags')).toBeInTheDocument();
    expect(within(await rowOf('One Rsvp')).getByText('0 projects · 1 RSVP · 2 tags')).toBeInTheDocument();
    const empty = await rowOf('Empty Account');
    expect(within(empty).getByText('0 projects · 0 tags')).toBeInTheDocument();
    expect(within(empty).queryByText(/RSVP/)).not.toBeInTheDocument();
  });

  it('lists the RSVPs in the detail panel, past events included, each linking to its event', async () => {
    mockFetch({
      rows: [makeRow({ slug: 'quiet-volunteer', fullName: 'Quiet Volunteer', footprint: { ...NO_FOOTPRINT, rsvps: 2 } })],
      details: {
        'quiet-volunteer': makeDetail([
          { event: { slug: 'next-hack-night', title: 'Next Hack Night', startsAt: '2026-11-24T23:00:00Z' }, createdAt: '2026-11-14T12:00:00Z' },
          { event: { slug: 'june-hack-night', title: 'June Hack Night', startsAt: '2025-06-10T11:00:00Z' }, createdAt: '2025-06-01T11:00:00Z' },
        ]),
      },
    });
    render('/admin/members/quiet-volunteer');

    const heading = await screen.findByRole('heading', { name: 'Event RSVPs' });
    const list = within(heading.parentElement!).getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole('link', { name: 'Next Hack Night' })).toHaveAttribute('href', '/events/next-hack-night');
    expect(within(items[1]!).getByRole('link', { name: 'June Hack Night' })).toHaveAttribute('href', '/events/june-hack-night');
    expect(items[1]!).toHaveTextContent(/June 10, 2025/);
    expect(items[1]!).toHaveTextContent(/RSVP'd June 1, 2025/);
  });

  it('leaves the RSVP section out when the member has none', async () => {
    mockFetch({
      rows: [makeRow({ slug: 'quiet-volunteer', fullName: 'Quiet Volunteer' })],
      details: { 'quiet-volunteer': makeDetail([]) },
    });
    render('/admin/members/quiet-volunteer');

    expect(await screen.findByText('No votes yet.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Event RSVPs' })).not.toBeInTheDocument();
  });
});
