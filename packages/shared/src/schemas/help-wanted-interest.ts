import { z } from 'zod';

export const HelpWantedInterestExpressionSchema = z.object({
  id: z.string().uuid(),
  roleId: z.string().uuid(),
  personId: z.string().uuid(),
  message: z.string().max(2_000).nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
});

export type HelpWantedInterestExpression = z.infer<typeof HelpWantedInterestExpressionSchema>;
