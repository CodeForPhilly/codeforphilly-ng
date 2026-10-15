import { z } from 'zod';

import { references } from '../references.js';

/**
 * A markdown update posted to a project, keyed on disk under the project's
 * handle (`project-updates/${projectSlug}/${number}`).
 * References the project by slug (specs/data-model.md → References).
 */
export const ProjectUpdateSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  projectSlug: z.string().min(1).meta(references('projects.slug')),
  authorId: z.string().uuid().nullable().optional(),
  body: z.string().min(1),
  number: z.number().int().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;
