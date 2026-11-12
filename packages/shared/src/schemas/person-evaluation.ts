import { z } from 'zod';

import { references } from '../references.js';

/**
 * One spam verdict per (person, evaluator) — the `person-evaluations` sheet.
 *
 * On the public data repo the only writer is the site: staff votes with
 * `evaluator = "human-<voterSlug>"` and agent votes with
 * `evaluator = "agent-<agentSlug>"`. Machine evaluators (heuristic, LLM) live
 * in the private spam-detection repo and share this shape so the prune can
 * aggregate both. See specs/behaviors/spam-exclusion.md.
 */
export const PersonEvaluationSchema = z.object({
  personSlug: z.string().min(1).meta(references('people.slug')),
  evaluator: z.string().min(1),
  verdict: z.enum(['spam', 'legit', 'uncertain']),
  /** LLM and human evaluators: 0–1 (human votes are 1). Absent on heuristic records. */
  confidence: z.number().min(0).max(1).optional(),
  /** Heuristic evaluators only: rule points, unbounded. */
  score: z.number().int().optional(),
  flags: z.array(z.string()),
  reasoning: z.string().optional(),
  evaluatedAt: z.string().datetime({ offset: true }),
});

export type PersonEvaluation = z.infer<typeof PersonEvaluationSchema>;

export const HUMAN_EVALUATOR_PREFIX = 'human-';
export const AGENT_EVALUATOR_PREFIX = 'agent-';

/**
 * The evaluator's kind, read from its prefix
 * (specs/behaviors/spam-exclusion.md → Where verdicts come from): a staff
 * member, an agent account on the site, or an offline machine pass.
 */
export type EvaluatorKind = 'human' | 'agent' | 'machine';

export function evaluatorKind(evaluator: string): EvaluatorKind {
  if (evaluator.startsWith(HUMAN_EVALUATOR_PREFIX)) return 'human';
  if (evaluator.startsWith(AGENT_EVALUATOR_PREFIX)) return 'agent';
  return 'machine';
}

/** The voter's slug for a `human-` or `agent-` evaluator, else null. */
export function evaluatorSlug(evaluator: string): string | null {
  if (evaluator.startsWith(HUMAN_EVALUATOR_PREFIX)) return evaluator.slice(HUMAN_EVALUATOR_PREFIX.length);
  if (evaluator.startsWith(AGENT_EVALUATOR_PREFIX)) return evaluator.slice(AGENT_EVALUATOR_PREFIX.length);
  return null;
}

export function isAgentEvaluator(evaluator: string): boolean {
  return evaluator.startsWith(AGENT_EVALUATOR_PREFIX);
}

export function agentEvaluatorFor(agentSlug: string): string {
  return `${AGENT_EVALUATOR_PREFIX}${agentSlug}`;
}

export function isHumanEvaluator(evaluator: string): boolean {
  return evaluator.startsWith(HUMAN_EVALUATOR_PREFIX);
}

export function humanEvaluatorFor(voterSlug: string): string {
  return `${HUMAN_EVALUATOR_PREFIX}${voterSlug}`;
}

export function personEvaluationKey(personSlug: string, evaluator: string): string {
  return `${personSlug}/${evaluator}`;
}
