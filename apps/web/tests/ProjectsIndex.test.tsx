import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderScreen, mockPaginated } from './test-utils.js';
import { ProjectsIndex } from '../src/screens/ProjectsIndex.js';
import { AuthProvider } from '../src/hooks/useAuth.js';

const SAMPLE_PROJECT = {
  id: 'p1',
  slug: 'sample-project',
  title: 'Sample Project',
  summary: 'A great civic project',
  stage: 'maintaining',
  overviewExcerpt: 'Overview excerpt',
  maintainer: null,
  memberCount: 0,
  members: [],
  links: { usersUrl: null, developersUrl: null, chatChannel: null },
  openHelpWantedCount: 2,
  tags: [{ namespace: 'tech', slug: 'react', title: 'React' }],
  updatedAt: '2026-05-10T12:00:00Z',
};

// Facet shape matches the API contract from specs/api/projects.md:
//   - tag facets use { tag, title, count }
//   - stage facet uses { stage, count }
const SAMPLE_FACETS = {
  byTopic: [
    { tag: 'topic.transit', title: 'Transit', count: 5 },
    { tag: 'topic.mapping', title: 'Mapping', count: 3 },
  ],
  byTech: [
    { tag: 'tech.react', title: 'React', count: 4 },
    { tag: 'tech.python', title: 'Python', count: 2 },
  ],
  byEvent: [],
  byStage: [
    { stage: 'maintaining', count: 1 },
    { stage: 'prototyping', count: 1 },
  ],
};

/**
 * Install a fetch spy that records every /api/projects call and returns
 * a stable response. Returns the spy so tests can read the calls.
 */
function installFetchSpy() {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string) => {
    if (input.startsWith('/api/auth/me')) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (input.startsWith('/api/projects')) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            mockPaginated([SAMPLE_PROJECT], { totalItems: 1, facets: SAMPLE_FACETS }),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch);
  return spy;
}

function projectsUrls(spy: ReturnType<typeof installFetchSpy>): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith('/api/projects'));
}

describe('ProjectsIndex', () => {
  let fetchSpy: ReturnType<typeof installFetchSpy>;

  beforeEach(() => {
    fetchSpy = installFetchSpy();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header with totalItems badge', async () => {
    renderScreen(
      <AuthProvider>
        <ProjectsIndex />
      </AuthProvider>,
      { initialEntries: ['/projects'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /civic projects directory/i })).toBeInTheDocument();
    });
  });

  it('renders project cards with title, stage badge, and help-wanted badge', async () => {
    renderScreen(
      <AuthProvider>
        <ProjectsIndex />
      </AuthProvider>,
      { initialEntries: ['/projects'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Sample Project' })).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Maintaining/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Help wanted \(2\)/)).toBeInTheDocument();
  });

  it('does not render Add Project button for anonymous users', async () => {
    renderScreen(
      <AuthProvider>
        <ProjectsIndex />
      </AuthProvider>,
      { initialEntries: ['/projects'] },
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /civic projects directory/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /add project/i })).not.toBeInTheDocument();
  });

  it('renders sidebar tag chips with the correct counts (no all-or-nothing handle bug)', async () => {
    renderScreen(
      <AuthProvider>
        <ProjectsIndex />
      </AuthProvider>,
      { initialEntries: ['/projects'] },
    );
    // Default tab is Topics — wait for the chip to land.
    const transitChip = await screen.findByRole('button', { name: /Transit/ });
    expect(transitChip).toBeInTheDocument();
    // The chip's accessible name should include its count.
    expect(transitChip.textContent).toMatch(/5/);
    // Mapping is also visible (and not represented by the same handle).
    expect(screen.getByRole('button', { name: /Mapping/ })).toBeInTheDocument();
  });

  it('clicking a topic chip adds the right tag handle to the URL and refetches', async () => {
    renderScreen(
      <AuthProvider>
        <ProjectsIndex />
      </AuthProvider>,
      { initialEntries: ['/projects'] },
    );

    const transitChip = await screen.findByRole('button', { name: /Transit/ });
    fireEvent.click(transitChip);

    await waitFor(() => {
      const urls = projectsUrls(fetchSpy);
      // The last /api/projects fetch must carry tag=topic.transit (and
      // only topic.transit — NOT topic. which was the symptom of the
      // FacetEntry shape bug).
      const last = urls[urls.length - 1] ?? '';
      expect(last).toContain('tag=topic.transit');
      expect(last).not.toContain('tag=topic.&');
      expect(last).not.toMatch(/tag=topic\.$/);
    });
  });

  it('clicking a stage pill in the row above results adds the stage to the URL', async () => {
    renderScreen(
      <AuthProvider>
        <ProjectsIndex />
      </AuthProvider>,
      { initialEntries: ['/projects'] },
    );

    // The stage filter row is a region above the search box.
    const stageRow = await screen.findByRole('group', { name: /stage filter/i });
    const prototypingPill = within(stageRow).getByRole('button', { name: /Prototyping/ });
    fireEvent.click(prototypingPill);

    await waitFor(() => {
      const urls = projectsUrls(fetchSpy);
      const last = urls[urls.length - 1] ?? '';
      expect(last).toContain('stageIn=prototyping');
    });
  });

  it('clicking the same topic chip twice toggles it off (no infinite stacking)', async () => {
    renderScreen(
      <AuthProvider>
        <ProjectsIndex />
      </AuthProvider>,
      { initialEntries: ['/projects'] },
    );

    // Sidebar is labelled "Filters"; scope queries there so the "active
    // filters" chip-row that appears after the first click doesn't shadow
    // the sidebar chip when we re-query for the second click.
    const sidebar = await screen.findByRole('complementary', { name: /Filters/ });
    fireEvent.click(within(sidebar).getByRole('button', { name: /Transit/ }));

    // Wait for the toggle-on fetch.
    await waitFor(() => {
      const last = projectsUrls(fetchSpy).slice(-1)[0] ?? '';
      expect(last).toContain('tag=topic.transit');
    });

    // Click again in the sidebar — should remove the tag from the URL.
    fireEvent.click(within(sidebar).getByRole('button', { name: /Transit/ }));

    await waitFor(() => {
      const last = projectsUrls(fetchSpy).slice(-1)[0] ?? '';
      expect(last).not.toContain('tag=topic.transit');
    });
  });
});
