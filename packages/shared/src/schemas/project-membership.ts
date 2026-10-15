import { z } from 'zod';

import { references } from '../references.js';

/**
 * A person's membership in a project. Keyed on disk by both handles
 * (`project-memberships/${projectSlug}/${personSlug}`), so it references
 * both by slug (specs/data-model.md → References).
 */
export const ProjectMembershipSchema = z.object({
  id: z.string().uuid(),
  projectSlug: z.string().min(1).meta(references('projects.slug')),
  personSlug: z.string().min(1).meta(references('people.slug')),
  role: z.string().nullable().optional(),
  isMaintainer: z.boolean().default(false),
  joinedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;
