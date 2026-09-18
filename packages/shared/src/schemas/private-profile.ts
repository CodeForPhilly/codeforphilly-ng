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

/**
 * What GitHub told us about the linked account, captured at every GitHub
 * sign-in and refreshed by the roster's probe. `status = "gone"` means
 * `GET /user/{id}` 404s — GitHub deleted or suspended the account.
 */
const GitHubFactsSchema = z.object({
  login: z.string(),
  accountCreatedAt: z.string().datetime({ offset: true }).nullable(),
  publicRepos: z.number().int().min(0).nullable(),
  followers: z.number().int().min(0).nullable(),
  following: z.number().int().min(0).nullable(),
  type: z.string().nullable(),
  status: z.enum(['ok', 'gone']),
  checkedAt: z.string().datetime({ offset: true }),
});

/** A Postmark bounce or complaint that means the mailbox is not going to work. */
const EmailBounceSchema = z.object({
  type: z.string(),
  bouncedAt: z.string().datetime({ offset: true }),
  description: z.string().nullable().optional(),
  inactive: z.boolean().optional(),
});

export const PrivateProfileSchema = z.object({
  personId: z.string().uuid(),
  email: z.string().email().toLowerCase(),
  emailRefreshedAt: z.string().datetime({ offset: true }),
  newsletter: NewsletterSchema.nullable().optional(),
  github: GitHubFactsSchema.nullable().optional(),
  /** Set whenever the SAML IdP issues an assertion for this person. */
  lastSlackSsoAt: z.string().datetime({ offset: true }).nullable().optional(),
  emailBounce: EmailBounceSchema.nullable().optional(),
  updatedAt: z.string().datetime({ offset: true }),
});

export type PrivateProfile = z.infer<typeof PrivateProfileSchema>;
export type Newsletter = z.infer<typeof NewsletterSchema>;
export type GitHubFacts = z.infer<typeof GitHubFactsSchema>;
export type EmailBounce = z.infer<typeof EmailBounceSchema>;
