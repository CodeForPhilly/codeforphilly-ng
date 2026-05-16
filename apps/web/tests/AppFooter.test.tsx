import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from './test-utils.js';
import { AppFooter } from '../src/components/AppFooter.js';

describe('AppFooter', () => {
  it('renders three column headings', () => {
    renderWithRouter(<AppFooter />);
    expect(screen.getByText('Explore')).toBeInTheDocument();
    expect(screen.getByText('About')).toBeInTheDocument();
    expect(screen.getByText('Connect')).toBeInTheDocument();
  });

  it('renders the open-source GitHub link', () => {
    renderWithRouter(<AppFooter />);
    const link = screen.getByRole('link', { name: /open source/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/CodeForPhilly/codeforphilly-rewrite',
    );
  });

  it('has no Twitter/X link', () => {
    renderWithRouter(<AppFooter />);
    const links = screen.getAllByRole('link');
    const hrefs = links.map((l) => l.getAttribute('href') ?? '');
    const twitterLinks = hrefs.filter(
      (h) => h.includes('twitter.com') || h.includes('x.com'),
    );
    expect(twitterLinks).toHaveLength(0);
  });

  it('renders social icons for Instagram, LinkedIn, Facebook, Meetup, Mastodon, Bluesky', () => {
    renderWithRouter(<AppFooter />);
    expect(
      screen.getByRole('link', { name: /instagram/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /linkedin/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /facebook/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /meetup/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /mastodon/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /bluesky/i }),
    ).toBeInTheDocument();
  });

  it('renders copyright notice', () => {
    renderWithRouter(<AppFooter />);
    const year = new Date().getFullYear();
    expect(screen.getByText(/copyright/i)).toBeInTheDocument();
    expect(screen.getByText(/2011/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(String(year)))).toBeInTheDocument();
  });
});
