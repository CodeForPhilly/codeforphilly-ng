import { z } from 'zod';

export const ProjectMembershipSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  personId: z.string().uuid(),
  role: z.string().nullable().optional(),
  isMaintainer: z.boolean().default(false),
  joinedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;
