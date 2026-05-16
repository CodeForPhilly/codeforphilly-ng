import { z } from 'zod';

export const HelpWantedRoleSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  postedById: z.string().uuid(),
  title: z.string().min(1).max(120),
  description: z.string().min(1),
  commitmentHoursPerWeek: z.number().int().min(0).nullable().optional(),
  status: z.enum(['open', 'filled', 'closed']).default('open'),
  filledById: z.string().uuid().nullable().optional(),
  filledAt: z.string().datetime({ offset: true }).nullable().optional(),
  closedAt: z.string().datetime({ offset: true }).nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type HelpWantedRole = z.infer<typeof HelpWantedRoleSchema>;
