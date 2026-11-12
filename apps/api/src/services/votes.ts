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
import type { Person, PersonEvaluation } from '@cfp/shared/schemas';

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
