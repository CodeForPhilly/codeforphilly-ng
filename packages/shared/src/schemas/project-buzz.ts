import { z } from 'zod';

// `passthrough()` so denormalized path-template fields (projectSlug) supplied
// by write services survive validation and reach gitsheets' path template
// renderer per specs/behaviors/storage.md#sheet-layout.
export const ProjectBuzzSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  projectId: z.string().uuid(),
  postedById: z.string().uuid().nullable().optional(),
  slug: z.string().min(1),
  headline: z.string().min(1).max(200),
  url: z.string().url(),
  publishedAt: z.string().datetime({ offset: true }),
  summary: z.string().nullable().optional(),
  imageKey: z.string().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

export type ProjectBuzz = z.infer<typeof ProjectBuzzSchema>;
