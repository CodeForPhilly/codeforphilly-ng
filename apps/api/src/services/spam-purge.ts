/**
 * Scheduled spam purge — specs/behaviors/person-lifecycle.md → "Scheduled
 * spam purge". A staff `spam` vote deactivates at once; once the votes have
 * stood unopposed for three days, a daily sweep purges every queued person in
 * one commit.
 */
import { evaluatorKind, type Person } from '@cfp/shared/schemas';
import type { FastifyBaseLogger } from 'fastify';

import type { FtsEngine } from '../store/fts.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import type { Store } from '../store/store.js';
import type { SessionMetadataStore } from '../auth/session-metadata.js';
import { purgePeople } from './person-purge.js';
import { decidingVotes } from './votes.js';
import { isAgentAccount } from '../auth/agent-grant.js';

/** How long a spam vote stands before the sweep acts on it. */
export const SPAM_PURGE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
/** How often the sweep runs. */
export const SPAM_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * When the sweep will purge `person`, or null if it won't
 * (specs/behaviors/person-lifecycle.md → Scheduled spam purge): every
 * deciding vote on their account is `spam`, they are still deactivated, not
 * staff and not an agent account, and the date is three days after the
 * newest deciding vote. The deciding votes are the human votes, or with none,
 * those of agents still holding an active grant (./votes.ts); votes cast on
 * an earlier account under the same slug never count.
 */
export function spamPurgeDueAt(state: InMemoryState, person: Person, now: Date = new Date()): Date | null {
  if (!person.deletedAt || person.accountLevel !== 'user') return null;
  if (isAgentAccount(state, person.slug)) return null;
  const votes = decidingVotes(state, person, now);
  if (votes.length === 0 || votes.some((v) => v.verdict !== 'spam')) return null;
  const newest = Math.max(...votes.map((v) => Date.parse(v.evaluatedAt)));
  return new Date(newest + SPAM_PURGE_GRACE_MS);
}

/** People the sweep would purge at `now`, by slug. */
export function queuedForSpamPurge(state: InMemoryState, now: Date): Person[] {
  return [...state.people.values()]
    .filter((p) => {
      const due = spamPurgeDueAt(state, p, now);
      return due !== null && due.getTime() <= now.getTime();
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The agents whose votes alone queued `person` (no human vote on the
 * account), e.g. `["agent-example-bot"]`; empty when a person decided.
 */
export function stagedBy(state: InMemoryState, person: Person, now: Date): string[] {
  const votes = decidingVotes(state, person, now);
  if (votes.length === 0 || votes.some((v) => evaluatorKind(v.evaluator) !== 'agent')) return [];
  return [...new Set(votes.map((v) => v.evaluator))].sort();
}

/** The sweep commit's slug lines: `<slug>` or `<slug> (staged by agent-<x>)`. */
export function sweepLines(state: InMemoryState, people: readonly Person[], now: Date): { lines: string[]; agentStaged: number } {
  let agentStaged = 0;
  const lines = people.map((p) => {
    const agents = stagedBy(state, p, now);
    if (agents.length === 0) return p.slug;
    agentStaged++;
    return `${p.slug} (staged by ${agents.join(', ')})`;
  });
  return { lines, agentStaged };
}

export interface SpamPurgeDeps {
  readonly state: InMemoryState;
  readonly fts: FtsEngine;
  readonly store: Store;
  readonly log: FastifyBaseLogger;
  readonly sessionMetadata: SessionMetadataStore;
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
    // A slug queued on agent votes alone says so, and the commit counts them,
    // so `git log` separates what a person decided from what only an agent did.
    const { lines, agentStaged } = sweepLines(this.#d.state, queued, now);

    const stateApply = new StateApply();
    try {
      await this.#d.store.transact(
        {
          message: `people: scheduled spam purge (${slugs.length})\n\n${lines.join('\n')}`,
          author: { name: 'cfp-api', email: 'api@codeforphilly.org' },
          ...(agentStaged > 0 ? { trailers: { 'Agent-Staged': String(agentStaged) } } : {}),
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
    for (const person of queued) {
      await this.#d.sessionMetadata.removeAllFor(person.id, this.#d.store.private);
    }
    this.#d.log.info({ purged: slugs }, 'scheduled spam purge');
    return slugs;
  }
}

class QueueChanged extends Error {}
