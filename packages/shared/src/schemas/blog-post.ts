import { z } from 'zod';

// `passthrough()` so denormalized path-template fields supplied by write
// services (none today since blog-posts is read-only via the importer +
// PRs, but kept consistent with other sheets) survive validation. Per
// specs/data-model.md#blogpost.
export const BlogPostSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  slug: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  summary: z.string().max(500).nullable().optional(),
  authorId: z.string().uuid().nullable().optional(),
  postedAt: z.string().datetime({ offset: true }),
  editedAt: z.string().datetime({ offset: true }).nullable().optional(),
  featuredImageKey: z.string().nullable().optional(),
  deletedAt: z.string().datetime({ offset: true }).nullable().optional(),
  body: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

export type BlogPost = z.infer<typeof BlogPostSchema>;
