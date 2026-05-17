/**
 * Account matching: resolve a GitHub OAuth identity to one of three outcomes
 * per specs/behaviors/account-migration.md:
 *
 *   1. existing       — Person.githubUserId === gh.id (already linked)
 *   2. create-fresh   — no candidates; route handler will create a new Person
 *   3. candidates     — one or more legacy Persons match by verified email or
 *                       weakly by username; claim-pending JWT routes to claim
 *
 * The match is best-effort, deterministic, and never auto-claims a legacy
 * candidate: email-match seeds the candidate set, username-match adds to it,
 * and the user is the one who confirms at /account-claim.
 */
import type { Person } from '@cfp/shared/schemas';
import type { InMemoryState } from '../store/memory/state.js';
import type { PrivateStore } from '../store/private/index.js';
import type { ResolvedGitHubIdentity } from '../auth/github-client.js';

export type MatchResult =
  | { kind: 'existing'; personId: string; person: Person }
  | { kind: 'create-fresh' }
  | { kind: 'candidates'; candidates: string[] };

function findPersonByGithubUserId(state: InMemoryState, ghUserId: number): Person | null {
  for (const person of state.people.values()) {
    if (person.githubUserId === ghUserId) return person;
  }
  return null;
}

export async function resolveIdentity(
  identity: ResolvedGitHubIdentity,
  state: InMemoryState,
  privateStore: PrivateStore,
): Promise<MatchResult> {
  // 1. Direct hit — already linked
  const linked = findPersonByGithubUserId(state, identity.id);
  if (linked) return { kind: 'existing', personId: linked.id, person: linked };

  // 2. Email match — scan verified emails against PrivateProfile.email
  const candidates = new Set<string>();
  for (const entry of identity.emails) {
    const email = entry.email.toLowerCase();
    const pid = await privateStore.findPersonIdByEmail(email);
    if (!pid) continue;
    const person = state.people.get(pid);
    // Skip already-linked persons — they belong to someone else's GH account.
    if (person && !person.githubUserId && !person.deletedAt) {
      candidates.add(pid);
    }
  }

  // 3. Username weak match — gh.login → Person.slug
  const usernameSlug = identity.login.toLowerCase();
  const usernameMatchId = state.personIdBySlug.get(usernameSlug);
  if (usernameMatchId) {
    const person = state.people.get(usernameMatchId);
    if (person && !person.githubUserId && !person.deletedAt) {
      candidates.add(usernameMatchId);
    }
  }

  if (candidates.size === 0) return { kind: 'create-fresh' };
  return { kind: 'candidates', candidates: [...candidates] };
}
