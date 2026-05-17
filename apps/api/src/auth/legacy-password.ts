/**
 * Legacy laddr password verification.
 *
 * Dispatches by hash format prefix so we can support whatever the laddr import
 * lands on. v1 supports bcrypt (`$2a$`, `$2b$`, `$2y$`). Other formats throw
 * UnknownHashFormatError so callers can surface a uniform "credentials invalid"
 * response (rather than leaking algorithm details) while still logging the
 * mismatch internally.
 */
import bcrypt from 'bcryptjs';

export class UnknownHashFormatError extends Error {
  constructor(prefix: string) {
    super(`Unknown legacy password hash format: ${prefix}`);
    this.name = 'UnknownHashFormatError';
  }
}

const BCRYPT_PREFIXES = ['$2a$', '$2b$', '$2y$'];

export async function verifyLaddrPassword(password: string, hash: string): Promise<boolean> {
  if (BCRYPT_PREFIXES.some((p) => hash.startsWith(p))) {
    return bcrypt.compare(password, hash);
  }
  throw new UnknownHashFormatError(hash.slice(0, Math.min(4, hash.length)));
}
