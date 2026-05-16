/**
 * mintSessionFor — issuance stub for tests and internal callers.
 *
 * The github-oauth plan will replace this with the real OAuth-backed flow.
 * Tests call this directly to exercise session mechanics without OAuth.
 */
import { type AccountLevel, issueSession } from './jwt.js';

export interface MintedSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessJti: string;
  readonly refreshJti: string;
}

export async function mintSessionFor(
  personId: string,
  accountLevel: AccountLevel,
  signingKey: string,
): Promise<MintedSession> {
  const { access, refresh, accessJti, refreshJti } = await issueSession(personId, accountLevel, signingKey);
  return { accessToken: access, refreshToken: refresh, accessJti, refreshJti };
}
