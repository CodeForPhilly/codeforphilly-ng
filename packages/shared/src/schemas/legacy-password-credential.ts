import { z } from 'zod';

// `lastUsedAt` is populated on every successful login (legacy password
// path) via the rehash-on-login rule in
// specs/behaviors/password-hash-rotation.md. Existing imported records
// have it undefined until first login. Supports the future
// coverage-metric reporting described in account-migration.md.
export const LegacyPasswordCredentialSchema = z.object({
  personId: z.string().uuid(),
  passwordHash: z.string().min(1),
  importedAt: z.string().datetime({ offset: true }),
  lastUsedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export type LegacyPasswordCredential = z.infer<typeof LegacyPasswordCredentialSchema>;
