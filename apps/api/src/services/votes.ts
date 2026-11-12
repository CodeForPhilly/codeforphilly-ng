/**
 * Which `person-evaluations` records belong to which account —
 * specs/api/moderation.md → "Votes belong to one account".
 *
 * Evaluations are keyed by slug and outlive a purge (they are the record of
 * why). A later sign-up can get the same slug, so a vote dated before the
 * person's `createdAt` was cast on an earlier account under that slug, and so
 * was a vote dated at or before the newest `spam-purges` record for the slug
 * that names another person (the purge ended that account). Such a vote counts
 * for nothing on this one: not in the roster's vote fields, not in the
 * reversal rule, not in the scheduled purge.
 */
import { evaluatorKind, evaluatorSlug, type Person, type PersonEvaluation } from '@cfp/shared/schemas';

import { agentHasActiveGrant } from '../auth/agent-grant.js';
import type { InMemoryState } from '../store/memory/state.js';

type AccountRef = Pick<Person, 'id' | 'slug' | 'createdAt'>;

/**
 * The time (ms) before which, inclusive, votes under this person's slug were
 * cast on an earlier account: the later of just before `createdAt` and the
 * newest `spam-purges` record for the slug that names another person.
 */
export function accountVoteCutoff(state: InMemoryState, person: AccountRef): number {
  let cutoff = Date.parse(person.createdAt) - 1;
  for (const id of state.spamPurgesBySlug.get(person.slug) ?? []) {
    const record = state.spamPurges.get(id);
    if (!record || record.personId === person.id) continue;
    cutoff = Math.max(cutoff, Date.parse(record.purgedAt));
  }
  return cutoff;
}

/** Whether `vote` was cast on this account (after its cutoff). */
export function isOnAccount(state: InMemoryState, vote: Pick<PersonEvaluation, 'evaluatedAt'>, person: AccountRef): boolean {
  return Date.parse(vote.evaluatedAt) > accountVoteCutoff(state, person);
}

/** Whether any `spam-purges` or `person-evaluations` record is keyed by `slug` (slug-handles.md). */
export function slugHasModerationHistory(state: InMemoryState, slug: string): boolean {
  return (state.spamPurgesBySlug.get(slug)?.size ?? 0) > 0 || (state.evaluationsByPerson.get(slug)?.size ?? 0) > 0;
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
export function votesOnAccount(state: InMemoryState, person: AccountRef): PersonEvaluation[] {
  const cutoff = accountVoteCutoff(state, person);
  return evaluationsForSlug(state, person.slug).filter((v) => Date.parse(v.evaluatedAt) > cutoff);
}

/** Evaluations under this slug cast on an earlier account (at or before the cutoff). */
export function votesOnEarlierAccounts(state: InMemoryState, person: AccountRef): PersonEvaluation[] {
  const cutoff = accountVoteCutoff(state, person);
  return evaluationsForSlug(state, person.slug).filter((v) => Date.parse(v.evaluatedAt) <= cutoff);
}

/** Votes on this account by staff (`human-*`). */
export function humanVotesOnAccount(state: InMemoryState, person: AccountRef): PersonEvaluation[] {
  return votesOnAccount(state, person).filter((v) => evaluatorKind(v.evaluator) === 'human');
}

/** Votes on this account by agents (`agent-*`). */
export function agentVotesOnAccount(state: InMemoryState, person: AccountRef): PersonEvaluation[] {
  return votesOnAccount(state, person).filter((v) => evaluatorKind(v.evaluator) === 'agent');
}

/** Whether any human has voted on this account. */
export function hasHumanVote(state: InMemoryState, person: AccountRef): boolean {
  return humanVotesOnAccount(state, person).length > 0;
}

/**
 * The deciding votes (specs/behaviors/person-lifecycle.md → Deciding votes):
 * the human votes on this account when there are any; otherwise the votes of
 * agents that hold an active grant at `now`.
 */
export function decidingVotes(
  state: InMemoryState,
  person: AccountRef,
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
export function stagedAgentVote(state: InMemoryState, person: AccountRef): PersonEvaluation | null {
  if (hasHumanVote(state, person)) return null;
  return newestVote(agentVotesOnAccount(state, person));
}
