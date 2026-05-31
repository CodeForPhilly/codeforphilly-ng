import { z } from 'zod';

/**
 * One-time password-reset token. Issued by `POST /api/auth/password-reset/request`,
 * consumed by `POST /api/auth/password-reset/confirm`.
 *
 * Per specs/api/auth.md and specs/behaviors/account-migration.md:
 * - Tokens are minted via CSPRNG and have a 1-hour expiry
 * - Single-use — `usedAt` is set on consumption; subsequent attempts fail
 * - Stored in the private store; the plaintext token only leaves over email
 *
 * The record itself stores a hash of the token (not the plaintext), so a
 * private-store leak doesn't immediately allow an attacker to reset anyone's
 * password. Verification: hash the user-supplied token and look up by hash.
 */
export const PasswordTokenSchema = z.object({
  /** SHA-256 hex of the plaintext token. The plaintext is never persisted. */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  personId: z.string().uuid(),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  /** ISO timestamp when the token was consumed; `null` while still valid. */
  usedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export type PasswordToken = z.infer<typeof PasswordTokenSchema>;
