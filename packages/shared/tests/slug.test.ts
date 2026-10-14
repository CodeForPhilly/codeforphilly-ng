import { describe, expect, it } from 'vitest';

import { normalizeLegacyHandle } from '../src/slug.js';

describe('normalizeLegacyHandle', () => {
  it('lowercases', () => {
    expect(normalizeLegacyHandle('Apps_for_Philly', 'project')).toBe('apps_for_philly');
    expect(normalizeLegacyHandle('ChrisAlfano', 'person')).toBe('chrisalfano');
  });

  it('keeps underscores for projects only', () => {
    expect(normalizeLegacyHandle('jane_doe', 'project')).toBe('jane_doe');
    expect(normalizeLegacyHandle('Jane_Doe', 'person')).toBe('jane-doe');
    expect(normalizeLegacyHandle('urban_design', 'tag')).toBe('urban-design');
  });

  it('collapses runs of disallowed characters into one hyphen', () => {
    expect(normalizeLegacyHandle('sheldon.md', 'project')).toBe('sheldon-md');
    expect(
      normalizeLegacyHandle('o.s.c.a.v.-open_system_for_computer_accessible_vision', 'project'),
    ).toBe('o-s-c-a-v--open_system_for_computer_accessible_vision');
    expect(normalizeLegacyHandle('jane..doe', 'person')).toBe('jane-doe');
  });

  it('trims leading and trailing separators', () => {
    expect(normalizeLegacyHandle('_jane_', 'project')).toBe('jane');
    expect(normalizeLegacyHandle('.jane.', 'person')).toBe('jane');
  });

  it('truncates to the entity max length', () => {
    expect(normalizeLegacyHandle('a'.repeat(90), 'project')).toHaveLength(80);
    expect(normalizeLegacyHandle('a'.repeat(60), 'person')).toHaveLength(50);
  });

  it('returns empty when nothing survives', () => {
    expect(normalizeLegacyHandle('...', 'person')).toBe('');
  });

  it('is idempotent on canonical slugs', () => {
    for (const s of ['chris', 'clean-and-green-philly', 'philly_bike_action']) {
      expect(normalizeLegacyHandle(s, 'project')).toBe(s);
    }
  });
});
