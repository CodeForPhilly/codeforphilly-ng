import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-_]{1,79}$/),
  title: z.string().min(1).max(200),
  summary: z.string().max(280).nullable().optional(),
  overview: z.string().nullable().optional(),
  stage: z
    .enum(['commenting', 'bootstrapping', 'prototyping', 'testing', 'maintaining', 'drifting', 'hibernating'])
    .default('commenting'),
  maintainerId: z.string().uuid().nullable().optional(),
  usersUrl: z.string().url().startsWith('https://').nullable().optional(),
  developersUrl: z.string().url().startsWith('https://').nullable().optional(),
  chatChannel: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/).nullable().optional(),
  featured: z.boolean().default(false),
  featuredImageKey: z.string().nullable().optional(),
  deletedAt: z.string().datetime({ offset: true }).nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).refine(
  (data) => !data.featured || (data.featuredImageKey != null && data.summary != null),
  { message: 'featured projects must have featuredImageKey and summary' },
);

export type Project = z.infer<typeof ProjectSchema>;
