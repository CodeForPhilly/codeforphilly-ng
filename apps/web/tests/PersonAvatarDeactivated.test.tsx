/**
 * Tests for the deactivated-person placeholder rendering in PersonAvatar.
 *
 * Spec: specs/behaviors/person-lifecycle.md, specs/api/people.md
 *   A deactivated person reference renders a non-linking placeholder.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from './test-utils.js';
import { PersonAvatar } from '../src/components/PersonAvatar.js';

describe('PersonAvatar — deactivated placeholder', () => {
  it('does not render a link when the person is deactivated (slug null)', () => {
    renderWithRouter(
      <PersonAvatar
        person={{ slug: null, fullName: 'Deactivated user', avatarUrl: null, deactivated: true }}
        asLink={true}
      />,
    );
    // No member link should be produced for a deactivated reference.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders a link for an active person reference', () => {
    renderWithRouter(
      <PersonAvatar
        person={{ slug: 'jane-doe', fullName: 'Jane Doe', avatarUrl: null }}
        asLink={true}
      />,
    );
    expect(screen.getByRole('link')).toHaveAttribute('href', '/members/jane-doe');
  });
});
