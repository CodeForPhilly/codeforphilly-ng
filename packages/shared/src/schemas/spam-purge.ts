import { z } from 'zod';

/** What an agent purge may cite as the spam the member posted. */
export const SPAM_EVIDENCE_RECORDS = ['person', 'project', 'project-update', 'project-buzz', 'help-wanted-role'] as const;
export type SpamEvidenceRecord = (typeof SPAM_EVIDENCE_RECORDS)[number];

export const SpamPurgeEvidenceSchema = z.object({
  record: z.enum(SPAM_EVIDENCE_RECORDS),
  /** The cited field, where the record has several text fields. */
  field: z.string().min(1).optional(),
  /** The record's data-repo path, e.g. `project-updates/example/3.toml`. */
  path: z.string().min(1),
});

export type SpamPurgeEvidence = z.infer<typeof SpamPurgeEvidenceSchema>;

/**
 * One record per person purged **as spam** — the `spam-purges` sheet,
 * `spam-purges/${personSlug}/${id}`. The log staff read once the member's
 * row is gone, and the sign-up block that keeps the same GitHub account from
 * coming straight back. See specs/data-model.md#spampurge.
 *
 * `personSlug` is deliberately **not** a reference: the person is gone and
 * the slug may be taken again, so a rename cascade never rewrites it.
 */
export const SpamPurgeSchema = z.object({
  id: z.string().uuid(),
  personSlug: z.string().min(1),
  personId: z.string().uuid(),
  githubUserId: z.number().int().min(1).nullable().optional(),
  purgedAt: z.string().datetime({ offset: true }),
  /** `human-<slug>`, `agent-<slug>`, or `scheduled`. */
  by: z.string().min(1),
  grantId: z.string().uuid().nullable().optional(),
  reason: z.string().min(1).max(1000).nullable().optional(),
  flags: z.array(z.string()),
  evidence: z.array(SpamPurgeEvidenceSchema),
  /** The data-repo commit the purge was applied on top of. */
  beforeCommit: z.string().min(1),
  blocksSignIn: z.boolean(),
  unblockedAt: z.string().datetime({ offset: true }).nullable().optional(),
  unblockedBySlug: z.string().min(1).nullable().optional(),
  unblockReason: z.string().max(1000).nullable().optional(),
});

export type SpamPurge = z.infer<typeof SpamPurgeSchema>;

/** The `by` value of a purge the daily sweep made. */
export const SCHEDULED_PURGER = 'scheduled';

/** Whether a record's sign-up block is in force. */
export function spamPurgeBlocks(record: Pick<SpamPurge, 'blocksSignIn' | 'unblockedAt'>): boolean {
  return record.blocksSignIn && !record.unblockedAt;
}
