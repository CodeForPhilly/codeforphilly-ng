import { z } from 'zod';

import { references } from '../references.js';

/**
 * Someone's interest in a help-wanted role, keyed on disk by the role's id
 * and the person's handle (`help-wanted-interest/${roleId}/${personSlug}`).
 * Roles are keyed by id, so `roleId` stays an id; the person is referenced
 * by slug (specs/data-model.md → References).
 */
export const HelpWantedInterestExpressionSchema = z.object({
  id: z.string().uuid(),
  roleId: z.string().uuid(),
  personSlug: z.string().min(1).meta(references('people.slug')),
  message: z.string().max(2_000).nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
});

export type HelpWantedInterestExpression = z.infer<typeof HelpWantedInterestExpressionSchema>;
