/**
 * Blog post routes per specs/api/blog.md.
 *
 *   GET /api/blog-posts          → paginated list, newest first, optional ?tag filter
 *   GET /api/blog-posts/:slug    → single post detail
 *
 * Public reads only — writes happen via PR to the data repo (the
 * content-typed gitsheets sheet's on-disk artifact is plain markdown
 * with TOML frontmatter). Per-author CMS writes are deferred to #45.
 */
import type { FastifyInstance } from 'fastify';
import { ok, paginated } from '../lib/response.js';
import { ApiNotFoundError } from '../lib/errors.js';

export async function blogPostRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/blog-posts
  fastify.get(
    '/api/blog-posts',
    {
      schema: {
        tags: ['blog-posts'],
        summary: 'List blog posts, newest postedAt first',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
            since: { type: 'string' },
            tag: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const q = request.query as Record<string, unknown>;
      const opts = {
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
        since: q['since'] as string | undefined,
        tag: q['tag'] as string[] | undefined,
      };

      const result = fastify.services.blogPosts.list(opts);

      const page = Math.max(1, opts.page ?? 1);
      const perPage = Math.min(100, Math.max(1, opts.perPage ?? 20));

      return paginated(result.items, {
        page,
        perPage,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / perPage),
      });
    },
  );

  // GET /api/blog-posts/:slug
  fastify.get(
    '/api/blog-posts/:slug',
    {
      schema: {
        tags: ['blog-posts'],
        summary: 'Fetch a single blog post by slug',
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
      },
    },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const post = fastify.services.blogPosts.findBySlug(slug);
      if (!post) throw new ApiNotFoundError(`Blog post '${slug}' not found`);
      return ok(post);
    },
  );
}
