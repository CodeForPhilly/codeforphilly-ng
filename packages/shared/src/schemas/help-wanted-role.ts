import { z } from 'zod';

// `passthrough()` so denormalized path-template fields (projectSlug) supplied
// by write services survive validation and reach gitsheets' path template
// renderer per specs/behaviors/storage.md#sheet-layout.
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
}).passthrough();

export type HelpWantedRole = z.infer<typeof HelpWantedRoleSchema>;
