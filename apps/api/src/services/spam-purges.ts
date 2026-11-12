/**
 * The spam-purge log and sign-up block — specs/data-model.md#spampurge,
 * specs/api/moderation.md → `GET /api/admin/spam-purges`,
 * `POST /api/admin/spam-purges/:id/unblock`.
 *
 * Every purge *as spam* — an agent purge, the daily sweep, or an
 * administrator's purge marked "This was spam" — leaves one public record
 * naming the purged slug and GitHub id, which keeps that GitHub account from
 * signing up again until staff unblock it.
 */
import { uuidv7 } from 'uuidv7';
import {
  SCHEDULED_PURGER,
  SpamPurgeSchema,
  evaluatorKind,
  evaluatorSlug,
  spamPurgeBlocks,
  type Person,
  type SpamPurge,
} from '@cfp/shared/schemas';

import { ApiNotFoundError } from '../lib/errors.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import type { DualStoreTx } from '../store/store.js';

/** A spam purge by an administrator or the sweep: no grant, no evidence. */
export function spamPurgeRecord(input: {
  readonly person: Person;
  readonly by: string;
  readonly reason: string | null;
  readonly beforeCommit: string;
  readonly purgedAt?: string;
}): SpamPurge {
  return SpamPurgeSchema.parse({
    id: uuidv7(),
    personSlug: input.person.slug,
    personId: input.person.id,
    ...(typeof input.person.githubUserId === 'number' ? { githubUserId: input.person.githubUserId } : {}),
    purgedAt: input.purgedAt ?? new Date().toISOString(),
    by: input.by,
    ...(input.reason ? { reason: input.reason } : {}),
    flags: [],
    evidence: [],
    beforeCommit: input.beforeCommit,
    blocksSignIn: true,
  });
}

export interface SpamPurgeFilters {
  /** `agent` | `human` | `scheduled`, or one evaluator (`agent-<slug>`, `human-<slug>`). */
  readonly by?: string;
  readonly slug?: string;
  readonly since?: string;
  readonly blocking?: boolean;
  readonly page?: number;
  readonly perPage?: number;
}

export interface PurgerRef {
  readonly kind: 'agent' | 'human' | 'scheduled';
  readonly slug: string | null;
  readonly fullName: string;
}

export interface SpamPurgeView extends SpamPurge {
  /** `by`, resolved. */
  readonly byRef: PurgerRef;
  readonly evidence: Array<SpamPurge['evidence'][number] & { readonly url: string }>;
  /** The history of the record's own path; its first entry is the purge commit. */
  readonly commitUrl: string;
  readonly blocking: boolean;
  readonly unblockedBy: { readonly slug: string; readonly fullName: string } | null;
}

/** Where purge-log links point: the data repo on GitHub, and the served branch. */
export interface DataRepoLinks {
  readonly webUrl: string;
  readonly branch: string;
}

/**
 * The data repo's GitHub web URL from `CFP_DATA_REMOTE` (ssh or https), else
 * the public `CodeForPhilly/codeforphilly-data`.
 */
export function dataRepoWebUrl(remote: string | undefined): string {
  const fallback = 'https://github.com/CodeForPhilly/codeforphilly-data';
  if (!remote) return fallback;
  const ssh = /^git@github\.com:(.+?)(?:\.git)?$/.exec(remote);
  if (ssh) return `https://github.com/${ssh[1]}`;
  const https = /^https:\/\/(?:[^@/]+@)?github\.com\/(.+?)(?:\.git)?\/?$/.exec(remote);
  if (https) return `https://github.com/${https[1]}`;
  return fallback;
}

export class SpamPurgeLogService {
  readonly #state: InMemoryState;
  readonly #links: DataRepoLinks;

  constructor(state: InMemoryState, links: DataRepoLinks) {
    this.#state = state;
    this.#links = links;
  }

  #fullName(slug: string): string {
    const id = this.#state.personIdBySlug.get(slug);
    return (id ? this.#state.people.get(id)?.fullName : undefined) ?? slug;
  }

  byRef(by: string): PurgerRef {
    if (by === SCHEDULED_PURGER) return { kind: 'scheduled', slug: null, fullName: 'Daily sweep' };
    const slug = evaluatorSlug(by) ?? by;
    return { kind: evaluatorKind(by) === 'agent' ? 'agent' : 'human', slug, fullName: this.#fullName(slug) };
  }

  view(record: SpamPurge): SpamPurgeView {
    const { webUrl, branch } = this.#links;
    return {
      ...record,
      byRef: this.byRef(record.by),
      evidence: record.evidence.map((e) => ({ ...e, url: `${webUrl}/blob/${record.beforeCommit}/${e.path}` })),
      commitUrl: `${webUrl}/commits/${branch}/spam-purges/${record.personSlug}/${record.id}.toml`,
      blocking: spamPurgeBlocks(record),
      unblockedBy: record.unblockedBySlug
        ? { slug: record.unblockedBySlug, fullName: this.#fullName(record.unblockedBySlug) }
        : null,
    };
  }

  list(filters: SpamPurgeFilters): { items: SpamPurgeView[]; totalItems: number; page: number; perPage: number } {
    let records = [...this.#state.spamPurges.values()];
    const by = filters.by;
    if (by) {
      records = records.filter((r) => {
        if (by === 'scheduled') return r.by === SCHEDULED_PURGER;
        if (by === 'agent' || by === 'human') return r.by !== SCHEDULED_PURGER && evaluatorKind(r.by) === by;
        return r.by === by;
      });
    }
    if (filters.slug) records = records.filter((r) => r.personSlug === filters.slug);
    if (filters.since) {
      const since = Date.parse(filters.since);
      records = records.filter((r) => Date.parse(r.purgedAt) >= since);
    }
    if (filters.blocking) records = records.filter((r) => spamPurgeBlocks(r));
    records.sort((a, b) => b.purgedAt.localeCompare(a.purgedAt) || b.id.localeCompare(a.id));
    const page = Math.max(1, filters.page ?? 1);
    const perPage = Math.min(200, Math.max(1, filters.perPage ?? 50));
    return {
      items: records.slice((page - 1) * perPage, page * perPage).map((r) => this.view(r)),
      totalItems: records.length,
      page,
      perPage,
    };
  }

  recordOr404(id: string): SpamPurge {
    const record = this.#state.spamPurges.get(id);
    if (!record) throw new ApiNotFoundError(`No spam purge '${id}'`);
    return record;
  }

  /** Lift the sign-up block; the record stays. Unblocking an unblocked record is a no-op. */
  async unblock(
    tx: DualStoreTx,
    id: string,
    staffSlug: string,
    reason: string | null,
  ): Promise<{ record: SpamPurge; stateApply: StateApply }> {
    const existing = this.recordOr404(id);
    if (existing.unblockedAt) return { record: existing, stateApply: new StateApply() };
    const record = SpamPurgeSchema.parse({
      ...existing,
      unblockedAt: new Date().toISOString(),
      unblockedBySlug: staffSlug,
      ...(reason ? { unblockReason: reason } : {}),
    });
    await tx.public['spam-purges'].upsert(record);
    return { record, stateApply: new StateApply().upsertSpamPurge(record) };
  }
}
