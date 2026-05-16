import { z } from 'zod';

// `passthrough()` so denormalized path-template fields (projectSlug, personSlug)
// supplied by write services survive validation and reach gitsheets' path
// template renderer per specs/behaviors/storage.md#sheet-layout.
export const ProjectMembershipSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  personId: z.string().uuid(),
  role: z.string().nullable().optional(),
  isMaintainer: z.boolean().default(false),
  joinedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;
