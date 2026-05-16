import { z } from 'zod';

export const TagSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  namespace: z.enum(['topic', 'tech', 'event']),
  slug: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Tag = z.infer<typeof TagSchema>;
