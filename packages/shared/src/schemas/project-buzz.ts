import { z } from 'zod';

export const ProjectBuzzSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  projectId: z.string().uuid(),
  postedById: z.string().uuid().nullable().optional(),
  slug: z.string().min(1),
  headline: z.string().min(1).max(200),
  url: z.string().url().startsWith('https://'),
  publishedAt: z.string().datetime({ offset: true }),
  summary: z.string().nullable().optional(),
  imageKey: z.string().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type ProjectBuzz = z.infer<typeof ProjectBuzzSchema>;
