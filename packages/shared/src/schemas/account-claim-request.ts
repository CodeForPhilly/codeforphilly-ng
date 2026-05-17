import { z } from 'zod';

export const AccountClaimRequestSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['pre-onboarding', 'post-onboarding-merge']),
  /**
   * Claimed legacy Person id — null when the user submitted a slug we can't
   * resolve. Kept null (rather than rejected) so anti-enumeration responses
   * remain uniform regardless of slug existence.
   */
  claimedPersonId: z.string().uuid().nullable(),
  claimedSlug: z.string().min(1),
  requesterGithubLogin: z.string().min(1),
  requesterGithubId: z.number().int(),
  /** Populated for post-onboarding-merge; null for pre-onboarding. */
  requesterPersonId: z.string().uuid().nullable(),
  evidence: z.string().max(5000),
  status: z.enum(['open', 'approved', 'denied']),
  submittedAt: z.string().datetime({ offset: true }),
  reviewedAt: z.string().datetime({ offset: true }).nullable(),
  reviewedBy: z.string().uuid().nullable(),
  reviewedReason: z.string().nullable(),
});

export type AccountClaimRequest = z.infer<typeof AccountClaimRequestSchema>;
