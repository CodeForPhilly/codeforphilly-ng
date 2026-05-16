import { z } from 'zod';

export const RevocationSchema = z.object({
  jti: z.string().min(1),
  personId: z.string().uuid(),
  revokedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});

export type Revocation = z.infer<typeof RevocationSchema>;
