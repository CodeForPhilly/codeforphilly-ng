import { z } from 'zod';

// `passthrough()` so denormalized path-template fields (personSlug) supplied
// by write services survive validation and reach gitsheets' path template
// renderer per specs/behaviors/storage.md#sheet-layout.
export const HelpWantedInterestExpressionSchema = z.object({
  id: z.string().uuid(),
  roleId: z.string().uuid(),
  personId: z.string().uuid(),
  message: z.string().max(2_000).nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
}).passthrough();

export type HelpWantedInterestExpression = z.infer<typeof HelpWantedInterestExpressionSchema>;
