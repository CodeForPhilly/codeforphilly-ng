/**
 * PKCE helpers per RFC 7636.
 *
 * GitHub's OAuth implementation accepts S256 PKCE on OAuth Apps, which
 * defends against authorization-code interception in addition to the
 * client-secret. We always require it per specs/api/auth.md.
 */
import { createHash, randomBytes } from 'node:crypto';

const VERIFIER_BYTES = 32;
const STATE_BYTES = 32;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

export function generatePkceVerifier(): string {
  return base64UrlEncode(randomBytes(VERIFIER_BYTES));
}

export function pkceChallengeFromVerifier(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

export function generateCsrfState(): string {
  return base64UrlEncode(randomBytes(STATE_BYTES));
}
