import { z } from 'zod';

export const SlugHistorySchema = z.object({
  id: z.string().uuid(),
  entityType: z.enum(['project', 'person', 'tag', 'buzz']),
  oldSlug: z.string().min(1),
  newSlug: z.string().min(1),
  entityId: z.string().uuid(),
  changedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});

export type SlugHistory = z.infer<typeof SlugHistorySchema>;
