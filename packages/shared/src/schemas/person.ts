import { z } from 'zod';

export const PersonSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/),
  fullName: z.string().min(1).max(120),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  bio: z.string().max(10_000).nullable().optional(),
  avatarKey: z.string().nullable().optional(),
  slackHandle: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,80}$/).nullable().optional(),
  accountLevel: z.enum(['user', 'staff', 'administrator']).default('user'),
  githubUserId: z.number().int().min(1).nullable().optional(),
  githubLogin: z
    .string()
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/)
    .nullable()
    .optional(),
  githubLinkedAt: z.string().datetime({ offset: true }).nullable().optional(),
  slackSamlNameId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/).nullable().optional(),
  deletedAt: z.string().datetime({ offset: true }).nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Person = z.infer<typeof PersonSchema>;
