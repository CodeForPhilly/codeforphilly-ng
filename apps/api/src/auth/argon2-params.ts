/**
 * Argon2id parameter source-of-truth.
 *
 * Bumping these values is a deliberate spec event per
 * specs/behaviors/password-hash-rotation.md — every subsequent
 * successful login rehashes credentials to the new floor, and the
 * corpus drifts naturally without retroactive backfill.
 *
 * Starting values produce ~50 ms hashes on the production pod's CPU
 * profile (Linode amd64). Within budget for POST /api/auth/login
 * latency.
 */
import argon2 from 'argon2';

export const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2, // iterations
  parallelism: 1,
} as const;
