import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';

/**
 * Render a component inside a MemoryRouter so that route-dependent components
 * (Link, NavLink, useNavigate, etc.) work in tests without a real browser.
 */
export function renderWithRouter(
  element: ReactElement,
  { initialEntries = ['/'] }: { initialEntries?: string[] } = {},
): RenderResult {
  return render(
    <MemoryRouter initialEntries={initialEntries}>{element}</MemoryRouter>,
  );
}
