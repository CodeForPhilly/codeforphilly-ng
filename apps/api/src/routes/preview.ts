/**
 * Server-side markdown preview.
 *
 * POST /api/_preview  { source: string }  → { html: string }
 *
 * Used by the shared <MarkdownEditor> on every authoring screen so that the
 * client never invokes a markdown library directly. See
 * specs/behaviors/markdown-rendering.md for the rule and pipeline; this route
 * is the lone exception to "rendering happens at serialize time" — it's the
 * editor preview path.
 */
import type { FastifyInstance } from 'fastify';
import { renderMarkdown } from '@cfp/shared';
import { ok } from '../lib/response.js';
import { ApiValidationError } from '../lib/errors.js';

const MAX_PREVIEW_LENGTH = 50_000;

export async function previewRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/_preview',
    {
      schema: {
        tags: ['preview'],
        summary: 'Render a markdown source string to sanitized HTML',
        body: {
          type: 'object',
          properties: { source: { type: 'string' } },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { source } = (request.body ?? {}) as { source: string };
      if (typeof source !== 'string') {
        throw new ApiValidationError('source must be a string', { source: 'required' });
      }
      if (source.length > MAX_PREVIEW_LENGTH) {
        throw new ApiValidationError('source too long for preview', {
          source: `must be ≤ ${MAX_PREVIEW_LENGTH} chars`,
        });
      }
      const { html } = renderMarkdown(source);
      return ok({ html });
    },
  );
}
