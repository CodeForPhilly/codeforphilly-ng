import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithRouter } from './test-utils.js';

function Hello() {
  return <p>Hello world</p>;
}

describe('test harness — web', () => {
  it('placeholder: arithmetic works', () => {
    expect(1 + 1).toBe(2);
  });

  it('renderWithRouter: renders a component inside a router', () => {
    renderWithRouter(<Hello />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });
});
