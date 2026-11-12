import { z } from 'zod';

import { references } from '../references.js';

/**
 * The scopes an agent grant may carry — specs/api/agents.md → Grants. There
 * are no others; `moderation:purge` is never implied by another scope and a
 * grant carrying it must also carry `moderation:read` (enforced where grants
 * are minted, not here, so the published contract stays a plain list).
 */
export const AGENT_SCOPES = ['moderation:read', 'moderation:vote', 'moderation:purge'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

/**
 * A scoped API grant for an agent account (an automated moderator) — the
 * `agent-grants` sheet, `agent-grants/${personSlug}/${id}`. Public: which
 * programs may act on the site, with which powers, granted by whom and until
 * when. The token is never stored here, nor its hash (that is private:
 * {@link AgentGrantSecretSchema}). See specs/data-model.md#agentgrant.
 */
export const AgentGrantSchema = z.object({
  id: z.string().uuid(),
  /**
   * The agent account. A declared slug reference, so the rename cascade covers
   * it, though an agent account is never renamed (specs/api/agents.md).
   */
  personSlug: z.string().min(1).meta(references('people.slug')),
  /** What and where, e.g. "ops bot, host vm-1". */
  label: z.string().min(1).max(80),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1),
  createdAt: z.string().datetime({ offset: true }),
  /** The administrator who minted it. */
  createdBySlug: z.string().min(1),
  /** At most 180 days after `createdAt`. */
  expiresAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export type AgentGrant = z.infer<typeof AgentGrantSchema>;

/**
 * The private half of a grant: the SHA-256 of its token, in the private
 * store's `agent-grant-secrets.jsonl` (specs/behaviors/private-storage.md).
 */
export const AgentGrantSecretSchema = z.object({
  grantId: z.string().uuid(),
  personId: z.string().uuid(),
  /** SHA-256 hex of the plaintext token. The plaintext is never persisted. */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Written at most once an hour per grant. */
  lastUsedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export type AgentGrantSecret = z.infer<typeof AgentGrantSecretSchema>;
