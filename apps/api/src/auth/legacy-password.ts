/**
 * Legacy password verification + rehash-on-login.
 *
 * Per specs/behaviors/password-hash-rotation.md. Dispatches by hash
 * format (SHA-1 unsalted, bcrypt, or argon2id), verifies in constant
 * time, and reports `needsRehash` so callers can rotate the
 * credential to argon2id on successful login. The corpus drifts
 * toward argon2id without forcing a password reset.
 *
 * Failure modes — wrong password, missing credential, unknown
 * format, internal error — collapse to `{ valid: false }` so callers
 * can return a uniform `invalid_credentials` response without
 * leaking algorithm or user-existence signal.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import argon2 from 'argon2';
import bcrypt from 'bcryptjs';

import { ARGON2_PARAMS } from './argon2-params.js';

const BCRYPT_PREFIXES = ['$2a$', '$2b$', '$2y$'];
const ARGON2ID_PREFIX = '$argon2id$';
const SHA1_HEX_RE = /^[0-9a-f]{40}$/;

export type VerifyResult =
  | { valid: true; needsRehash: boolean }
  | { valid: false };

/**
 * Verify a plaintext password against a stored hash.
 *
 * Returns `{ valid: true, needsRehash }` on a successful match; the
 * caller is responsible for rotating to argon2id when `needsRehash`
 * is true.
 *
 * Any failure path — wrong password, unrecognized format, internal
 * error during verify — returns `{ valid: false }` without leaking
 * the cause. Internal errors are not re-thrown.
 */
export async function verifyLegacyPassword(
  password: string,
  hash: string,
): Promise<VerifyResult> {
  try {
    if (hash.startsWith(ARGON2ID_PREFIX)) {
      const ok = await argon2.verify(hash, password);
      if (!ok) return { valid: false };
      // Argon2's encoded format embeds the params; if they don't match
      // the current floor, the credential is correct but stale —
      // rotate.
      return { valid: true, needsRehash: argonNeedsRehash(hash) };
    }

    if (BCRYPT_PREFIXES.some((p) => hash.startsWith(p))) {
      const ok = await bcrypt.compare(password, hash);
      if (!ok) return { valid: false };
      // Spec unifies on argon2id; every bcrypt source rotates on login.
      // (Laddr is SHA-1, not bcrypt; the bcrypt branch is defensive
      // fallback for any future bcrypt-imported credentials.)
      return { valid: true, needsRehash: true };
    }

    if (SHA1_HEX_RE.test(hash)) {
      const computedHex = createHash('sha1').update(password).digest('hex');
      // Length-check before timingSafeEqual — equal lengths are
      // guaranteed by the regex on `hash` plus sha1's fixed 40-char
      // output, but defense in depth: timingSafeEqual throws
      // synchronously on length mismatch, which would itself be a
      // timing oracle if the throw vs. compare paths differ.
      if (computedHex.length !== hash.length) return { valid: false };
      const ok = timingSafeEqual(
        Buffer.from(computedHex, 'hex'),
        Buffer.from(hash, 'hex'),
      );
      if (!ok) return { valid: false };
      return { valid: true, needsRehash: true };
    }

    // Unknown format. No throw — uniform invalid response.
    return { valid: false };
  } catch {
    // Library error, malformed hash that slipped past the regex,
    // anything else — collapse to invalid. Never leak via different
    // outcomes.
    return { valid: false };
  }
}

/**
 * Hash a plaintext password to argon2id with current params. Used
 * after a successful verify when `needsRehash` is true, and by the
 * password-reset confirm flow (phase C).
 */
export async function rehashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_PARAMS);
}

/**
 * Returns true when the supplied argon2id-encoded hash uses
 * parameters different from the current floor (`ARGON2_PARAMS`).
 */
function argonNeedsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_PARAMS);
  } catch {
    // If parsing the encoded hash fails, conservatively rotate.
    return true;
  }
}

/**
 * Pre-computed argon2id hash of a fixed sentinel plaintext. Computed
 * lazily on first `dummyVerify` so we don't block module load.
 */
let dummyHashPromise: Promise<string> | null = null;
function ensureDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = rehashPassword('this-string-is-never-a-real-password');
  }
  return dummyHashPromise;
}

/**
 * Run an argon2 verify against a fixed sentinel hash. Always returns
 * `{ valid: false }`. Callers invoke this when the user or credential
 * lookup misses so the overall response timing matches the success
 * path — per specs/behaviors/password-hash-rotation.md
 * § anti-enumeration timing.
 */
export async function dummyVerify(): Promise<VerifyResult> {
  try {
    const dummy = await ensureDummyHash();
    await argon2.verify(dummy, 'this-string-also-never-a-real-password');
  } catch {
    // Outcome doesn't matter — purpose is timing, not correctness.
  }
  return { valid: false };
}
