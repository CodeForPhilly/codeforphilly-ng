import { z } from 'zod';

/**
 * One spam verdict per (person, evaluator) — the `person-evaluations` sheet.
 *
 * On the public data repo the only writer is the site: staff votes with
 * `evaluator = "human-<voterSlug>"`. Machine evaluators (heuristic, LLM) live
 * in the private spam-detection repo and share this shape so the prune can
 * aggregate both. See specs/behaviors/spam-exclusion.md.
 */
export const PersonEvaluationSchema = z.object({
  personSlug: z.string().min(1),
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

export function isHumanEvaluator(evaluator: string): boolean {
  return evaluator.startsWith(HUMAN_EVALUATOR_PREFIX);
}

export function humanEvaluatorFor(voterSlug: string): string {
  return `${HUMAN_EVALUATOR_PREFIX}${voterSlug}`;
}

export function personEvaluationKey(personSlug: string, evaluator: string): string {
  return `${personSlug}/${evaluator}`;
}
