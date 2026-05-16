import { z } from 'zod';

export const LegacyPasswordCredentialSchema = z.object({
  personId: z.string().uuid(),
  passwordHash: z.string().min(1),
  importedAt: z.string().datetime({ offset: true }),
});

export type LegacyPasswordCredential = z.infer<typeof LegacyPasswordCredentialSchema>;
