/**
 * Scheduled spam purge — specs/behaviors/person-lifecycle.md → "Scheduled
 * spam purge". A staff `spam` vote deactivates at once; once the votes have
 * stood unopposed for three days, a daily sweep purges every queued person in
 * one commit.
 */
import { isHumanEvaluator, type Person } from '@cfp/shared/schemas';
import type { FastifyBaseLogger } from 'fastify';

import type { FtsEngine } from '../store/fts.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import type { Store } from '../store/store.js';
import { purgePeople } from './person-purge.js';

/** How long a spam vote stands before the sweep acts on it. */
export const SPAM_PURGE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
/** How often the sweep runs. */
export const SPAM_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * When the sweep will purge `person`, or null if it won't: every human vote
 * on them is `spam`, they are still deactivated and not staff, and the date is
 * three days after the newest vote.
 */
export function spamPurgeDueAt(state: InMemoryState, person: Person): Date | null {
  if (!person.deletedAt || person.accountLevel !== 'user') return null;
  const votes = [...(state.evaluationsByPerson.get(person.slug) ?? [])]
    .map((key) => state.personEvaluations.get(key))
    .filter((e) => e !== undefined && isHumanEvaluator(e.evaluator));
  if (votes.length === 0 || votes.some((v) => v!.verdict !== 'spam')) return null;
  const newest = Math.max(...votes.map((v) => Date.parse(v!.evaluatedAt)));
  return new Date(newest + SPAM_PURGE_GRACE_MS);
}

/** People the sweep would purge at `now`, by slug. */
export function queuedForSpamPurge(state: InMemoryState, now: Date): Person[] {
  return [...state.people.values()]
    .filter((p) => {
      const due = spamPurgeDueAt(state, p);
      return due !== null && due.getTime() <= now.getTime();
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export interface SpamPurgeDeps {
  readonly state: InMemoryState;
  readonly fts: FtsEngine;
  readonly store: Store;
  readonly log: FastifyBaseLogger;
}

export class SpamPurgeService {
  readonly #d: SpamPurgeDeps;

  constructor(deps: SpamPurgeDeps) {
    this.#d = deps;
  }

  /** Purge everyone queued at `now` in one commit; returns their slugs. */
  async sweep(now: Date = new Date()): Promise<string[]> {
    const queued = queuedForSpamPurge(this.#d.state, now);
    if (queued.length === 0) return [];
    const slugs = queued.map((p) => p.slug);

    const stateApply = new StateApply();
    try {
      await this.#d.store.transact(
        {
          message: `people: scheduled spam purge (${slugs.length})\n\n${slugs.join('\n')}`,
          author: { name: 'cfp-api', email: 'api@codeforphilly.org' },
        },
        async (tx) => {
          // Re-check inside the write mutex: a vote or reactivation that landed
          // since the queue was read wins, and the batch waits for the next run.
          const current = queuedForSpamPurge(this.#d.state, now).map((p) => p.slug);
          if (current.join() !== slugs.join()) throw new QueueChanged();
          await purgePeople(tx, this.#d.state, stateApply, queued);
        },
      );
    } catch (err) {
      if (err instanceof QueueChanged) {
        this.#d.log.info('scheduled spam purge: queue changed mid-run, retrying next run');
        return [];
      }
      throw err;
    }
    stateApply.apply(this.#d.state, this.#d.fts);
    this.#d.log.info({ purged: slugs }, 'scheduled spam purge');
    return slugs;
  }
}

class QueueChanged extends Error {}
