import { z } from 'zod';

export const TagAssignmentSchema = z.object({
  id: z.string().uuid(),
  tagId: z.string().uuid(),
  taggableType: z.enum(['project', 'person', 'help_wanted_role', 'blog_post']),
  taggableId: z.string().uuid(),
  assignedById: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
});

export type TagAssignment = z.infer<typeof TagAssignmentSchema>;
