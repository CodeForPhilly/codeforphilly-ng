import { z } from 'zod';

const NewsletterSchema = z.object({
  optedIn: z.boolean(),
  optedInAt: z.string().datetime({ offset: true }).nullable().optional(),
  optedOutAt: z.string().datetime({ offset: true }).nullable().optional(),
  unsubscribeToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .nullable()
    .optional(),
});

export const PrivateProfileSchema = z.object({
  personId: z.string().uuid(),
  email: z.string().email().toLowerCase(),
  emailRefreshedAt: z.string().datetime({ offset: true }),
  newsletter: NewsletterSchema.nullable().optional(),
  updatedAt: z.string().datetime({ offset: true }),
});

export type PrivateProfile = z.infer<typeof PrivateProfileSchema>;
export type Newsletter = z.infer<typeof NewsletterSchema>;
