import { z } from 'zod';

import { references } from '../references.js';

/**
 * Press / media coverage of a project, keyed on disk under the project's
 * handle (`project-buzz/${projectSlug}/${slug}`).
 * References the project by slug (specs/data-model.md → References).
 */
export const ProjectBuzzSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  projectSlug: z.string().min(1).meta(references('projects.slug')),
  postedById: z.string().uuid().nullable().optional(),
  slug: z.string().min(1),
  headline: z.string().min(1).max(200),
  url: z.string().url(),
  publishedAt: z.string().datetime({ offset: true }),
  summary: z.string().nullable().optional(),
  imageKey: z.string().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type ProjectBuzz = z.infer<typeof ProjectBuzzSchema>;
