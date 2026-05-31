/**
 * Verifier tests for the three-algorithm dispatcher per
 * specs/behaviors/password-hash-rotation.md.
 *
 * The dummy-verify timing test is intentionally loose (within ~3x of
 * a real verify on the same machine) — we're checking the order of
 * magnitude, not micro-benchmarking. Anti-enumeration only needs
 * "comparable," not "identical."
 */
import { createHash } from 'node:crypto';

import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';

import { ARGON2_PARAMS } from '../src/auth/argon2-params.js';
import {
  dummyVerify,
  rehashPassword,
  verifyLegacyPassword,
} from '../src/auth/legacy-password.js';

const CORRECT = 'correct horse battery staple';
const WRONG = 'tr0ub4dor';

describe('verifyLegacyPassword — argon2id', () => {
  it('returns valid + no rehash for a hash with current params', async () => {
    const hash = await argon2.hash(CORRECT, ARGON2_PARAMS);
    const r = await verifyLegacyPassword(CORRECT, hash);
    expect(r).toEqual({ valid: true, needsRehash: false });
  });

  it('returns valid + needsRehash for stale params', async () => {
    // Lower-cost params than the floor — encodes differently so
    // argon2.needsRehash returns true.
    const stale = await argon2.hash(CORRECT, {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
    });
    const r = await verifyLegacyPassword(CORRECT, stale);
    expect(r).toEqual({ valid: true, needsRehash: true });
  });

  it('returns invalid for wrong password', async () => {
    const hash = await argon2.hash(CORRECT, ARGON2_PARAMS);
    const r = await verifyLegacyPassword(WRONG, hash);
    expect(r).toEqual({ valid: false });
  });
});

describe('verifyLegacyPassword — bcrypt', () => {
  it('returns valid + needsRehash for a bcrypt hash', async () => {
    const hash = await bcrypt.hash(CORRECT, 4);
    const r = await verifyLegacyPassword(CORRECT, hash);
    expect(r).toEqual({ valid: true, needsRehash: true });
  });

  it('returns invalid for wrong password against a bcrypt hash', async () => {
    const hash = await bcrypt.hash(CORRECT, 4);
    const r = await verifyLegacyPassword(WRONG, hash);
    expect(r).toEqual({ valid: false });
  });
});

describe('verifyLegacyPassword — SHA-1 (legacy laddr)', () => {
  function sha1Hex(input: string): string {
    return createHash('sha1').update(input).digest('hex');
  }

  it('returns valid + needsRehash for a correct SHA-1 hash', async () => {
    const r = await verifyLegacyPassword(CORRECT, sha1Hex(CORRECT));
    expect(r).toEqual({ valid: true, needsRehash: true });
  });

  it('returns invalid for wrong password against a SHA-1 hash', async () => {
    const r = await verifyLegacyPassword(WRONG, sha1Hex(CORRECT));
    expect(r).toEqual({ valid: false });
  });

  it('does not throw on a malformed near-SHA-1 input that bypasses the regex check', async () => {
    // The regex enforces 40 lowercase hex; uppercase hex is rejected
    // by the regex and falls through to "unknown format" without
    // throwing.
    const r = await verifyLegacyPassword(CORRECT, 'ABCDEF0123456789ABCDEF0123456789ABCDEF01');
    expect(r).toEqual({ valid: false });
  });
});

describe('verifyLegacyPassword — unknown format', () => {
  it('returns invalid for arbitrary strings', async () => {
    const r = await verifyLegacyPassword(CORRECT, 'not-a-hash');
    expect(r).toEqual({ valid: false });
  });

  it('returns invalid for empty hash', async () => {
    const r = await verifyLegacyPassword(CORRECT, '');
    expect(r).toEqual({ valid: false });
  });

  it('returns invalid for an argon2 prefix with corrupt body', async () => {
    const r = await verifyLegacyPassword(CORRECT, '$argon2id$totally-bogus');
    expect(r).toEqual({ valid: false });
  });
});

describe('rehashPassword', () => {
  it('produces a parseable argon2id hash that verifies the original plaintext', async () => {
    const hash = await rehashPassword(CORRECT);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    const r = await verifyLegacyPassword(CORRECT, hash);
    expect(r).toEqual({ valid: true, needsRehash: false });
  });
});

describe('dummyVerify (timing floor)', () => {
  it('always returns invalid', async () => {
    const r = await dummyVerify();
    expect(r).toEqual({ valid: false });
  });

  it('takes time comparable to a real verify (order of magnitude)', async () => {
    // Warm both paths so the lazy dummy-hash precomputation doesn't
    // skew the first-call timing.
    const realHash = await argon2.hash(CORRECT, ARGON2_PARAMS);
    await verifyLegacyPassword(CORRECT, realHash); // warm argon2
    await dummyVerify(); // warm dummy hash precomputation

    const t0 = performance.now();
    await verifyLegacyPassword(CORRECT, realHash);
    const realMs = performance.now() - t0;

    const t1 = performance.now();
    await dummyVerify();
    const dummyMs = performance.now() - t1;

    // Within 3x in either direction. Argon2 timings vary by CI host;
    // this just guards against the dummy being trivially fast (e.g.
    // 0.1 ms vs 50 ms would be a measurable enumeration oracle).
    expect(dummyMs).toBeGreaterThan(realMs / 3);
    expect(dummyMs).toBeLessThan(realMs * 3);
  });
});
