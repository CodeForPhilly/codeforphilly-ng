/**
 * Full-text query shaping — specs/behaviors/storage.md#full-text-search:
 * every word must match, the last word matches as a prefix.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeFtsQuery } from '../src/store/fts.js';

describe('sanitizeFtsQuery', () => {
  it('quotes each word and makes the last one a prefix', () => {
    expect(sanitizeFtsQuery('civic eng')).toBe('"civic" "eng"*');
    expect(sanitizeFtsQuery('hack')).toBe('"hack"*');
  });

  it('trims, collapses whitespace, and escapes quotes', () => {
    expect(sanitizeFtsQuery('  say "hi"   there ')).toBe('"say" """hi""" "there"*');
    expect(sanitizeFtsQuery('   ')).toBe('');
  });
});
