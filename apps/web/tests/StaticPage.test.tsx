import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { renderScreen } from './test-utils.js';
import { StaticPage } from '../src/pages/StaticPage.js';

describe('StaticPage', () => {
  function renderAt(path: string) {
    renderScreen(
      <Routes>
        <Route path="/pages/:slug" element={<StaticPage />} />
      </Routes>,
      { initialEntries: [path] },
    );
  }

  it('renders the Mission page H1', () => {
    renderAt('/pages/mission');
    expect(screen.getByRole('heading', { name: /^mission$/i, level: 1 })).toBeInTheDocument();
  });

  it('renders the Leadership page', () => {
    renderAt('/pages/leadership');
    expect(screen.getByRole('heading', { name: /^leadership$/i, level: 1 })).toBeInTheDocument();
  });

  it('renders the Code of Conduct page', () => {
    renderAt('/pages/code-of-conduct');
    expect(
      screen.getByRole('heading', { name: /^code of conduct$/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it('renders the Hackathons page', () => {
    renderAt('/pages/hackathons');
    expect(screen.getByRole('heading', { name: /^hackathons$/i, level: 1 })).toBeInTheDocument();
  });

  it('renders NotFound for an unknown slug', () => {
    renderAt('/pages/nonexistent-page');
    // The NotFound screen renders a recognizable not-found message.
    expect(screen.getByText(/page not found|not found/i)).toBeInTheDocument();
  });

  it('renders markdown headings as semantic h2/h3', () => {
    renderAt('/pages/mission');
    // The Mission page has a "What we do" h2.
    expect(screen.getByRole('heading', { name: /what we do/i, level: 2 })).toBeInTheDocument();
  });

  it('renders inline links from markdown', () => {
    renderAt('/pages/mission');
    // [projects](/projects) → an <a href="/projects">projects</a>.
    const link = screen.getByRole('link', { name: /^projects$/ });
    expect(link).toHaveAttribute('href', '/projects');
  });
});
