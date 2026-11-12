/**
 * Which `person-evaluations` records belong to which account —
 * specs/api/moderation.md → "Votes belong to one account".
 *
 * Evaluations are keyed by slug and outlive a purge (they are the record of
 * why). A later sign-up can get the same slug, so a vote dated before the
 * person's `createdAt` was cast on an earlier account under that slug and
 * counts for nothing on this one: not in the roster's vote fields, not in the
 * reversal rule, not in the scheduled purge.
 */
import { evaluatorKind, evaluatorSlug, type Person, type PersonEvaluation } from '@cfp/shared/schemas';

import { agentHasActiveGrant } from '../auth/agent-grant.js';
import type { InMemoryState } from '../store/memory/state.js';

/** Whether `vote` was cast on this account (at or after its `createdAt`). */
export function isOnAccount(vote: Pick<PersonEvaluation, 'evaluatedAt'>, createdAt: string): boolean {
  return Date.parse(vote.evaluatedAt) >= Date.parse(createdAt);
}

/** Every evaluation on record under `slug`, current account or not. */
export function evaluationsForSlug(state: InMemoryState, slug: string): PersonEvaluation[] {
  const out: PersonEvaluation[] = [];
  for (const key of state.evaluationsByPerson.get(slug) ?? []) {
    const rec = state.personEvaluations.get(key);
    if (rec) out.push(rec);
  }
  return out;
}

/** The evaluations cast on this person's own account. */
export function votesOnAccount(state: InMemoryState, person: Pick<Person, 'slug' | 'createdAt'>): PersonEvaluation[] {
  return evaluationsForSlug(state, person.slug).filter((v) => isOnAccount(v, person.createdAt));
}

/** Evaluations under this slug cast on an earlier account (before `createdAt`). */
export function votesOnEarlierAccounts(
  state: InMemoryState,
  person: Pick<Person, 'slug' | 'createdAt'>,
): PersonEvaluation[] {
  return evaluationsForSlug(state, person.slug).filter((v) => !isOnAccount(v, person.createdAt));
}

/** Votes on this account by staff (`human-*`). */
export function humanVotesOnAccount(state: InMemoryState, person: Pick<Person, 'slug' | 'createdAt'>): PersonEvaluation[] {
  return votesOnAccount(state, person).filter((v) => evaluatorKind(v.evaluator) === 'human');
}

/** Votes on this account by agents (`agent-*`). */
export function agentVotesOnAccount(state: InMemoryState, person: Pick<Person, 'slug' | 'createdAt'>): PersonEvaluation[] {
  return votesOnAccount(state, person).filter((v) => evaluatorKind(v.evaluator) === 'agent');
}

/** Whether any human has voted on this account. */
export function hasHumanVote(state: InMemoryState, person: Pick<Person, 'slug' | 'createdAt'>): boolean {
  return humanVotesOnAccount(state, person).length > 0;
}

/**
 * The deciding votes (specs/behaviors/person-lifecycle.md → Deciding votes):
 * the human votes on this account when there are any; otherwise the votes of
 * agents that hold an active grant at `now`.
 */
export function decidingVotes(
  state: InMemoryState,
  person: Pick<Person, 'slug' | 'createdAt'>,
  now: Date = new Date(),
): PersonEvaluation[] {
  const humans = humanVotesOnAccount(state, person);
  if (humans.length > 0) return humans;
  return agentVotesOnAccount(state, person).filter((v) => {
    const agentSlug = evaluatorSlug(v.evaluator);
    return agentSlug !== null && agentHasActiveGrant(state, agentSlug, now);
  });
}

/** The newest of `votes`, or null. */
export function newestVote(votes: readonly PersonEvaluation[]): PersonEvaluation | null {
  let newest: PersonEvaluation | null = null;
  for (const v of votes) if (!newest || Date.parse(v.evaluatedAt) > Date.parse(newest.evaluatedAt)) newest = v;
  return newest;
}

/**
 * The newest agent vote on this account when no human has voted on it, else
 * null — what the roster shows as `stagedVote`.
 */
export function stagedAgentVote(state: InMemoryState, person: Pick<Person, 'slug' | 'createdAt'>): PersonEvaluation | null {
  if (hasHumanVote(state, person)) return null;
  return newestVote(agentVotesOnAccount(state, person));
}
