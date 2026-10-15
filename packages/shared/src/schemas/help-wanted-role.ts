import { z } from 'zod';

import { references } from '../references.js';

/**
 * A help-wanted role posted by a project, keyed on disk under the project's
 * handle (`help-wanted-roles/${projectSlug}/${id}`).
 * References the project by slug (specs/data-model.md → References).
 */
export const HelpWantedRoleSchema = z.object({
  id: z.string().uuid(),
  projectSlug: z.string().min(1).meta(references('projects.slug')),
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
