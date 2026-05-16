import { z } from 'zod';

export const ProjectUpdateSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  projectId: z.string().uuid(),
  authorId: z.string().uuid().nullable().optional(),
  body: z.string().min(1),
  number: z.number().int().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;
