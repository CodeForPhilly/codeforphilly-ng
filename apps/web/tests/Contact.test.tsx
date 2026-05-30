import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderScreen } from './test-utils.js';
import { Contact } from '../src/pages/Contact.js';

describe('Contact', () => {
  it('renders a mailto link to hello@codeforphilly.org', () => {
    renderScreen(<Contact />, { initialEntries: ['/contact'] });
    expect(screen.getByRole('heading', { name: /^contact$/i })).toBeInTheDocument();
    const mailtoLink = screen.getByRole('link', { name: /hello@codeforphilly\.org/i });
    expect(mailtoLink).toHaveAttribute('href', 'mailto:hello@codeforphilly.org');
  });

  it('links to /chat for real-time chat', () => {
    renderScreen(<Contact />, { initialEntries: ['/contact'] });
    const slackLink = screen.getByRole('link', { name: /slack workspace/i });
    expect(slackLink).toHaveAttribute('href', '/chat');
  });
});
