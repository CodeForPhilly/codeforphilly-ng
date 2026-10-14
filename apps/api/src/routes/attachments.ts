/**
 * Attachment serving.
 *
 *   GET /api/attachments/*  →  the gitsheets attachment at the path captured
 *                              by the wildcard segment
 *
 * Per specs/behaviors/storage.md → "Attachments": the key is the attachment's
 * path in the data tree, `<sheet>/<record path>/<name>`. It resolves through
 * the sheet's `getAttachment()`, which reads the blob hash in-core from the
 * sheet's read snapshot. That snapshot is fresh after our own commits
 * (gitsheets auto-refresh) and after a hot reload (`store.public.refresh()`).
 *
 * The blob hash is the `ETag`, so a revalidation is answered with 304 without
 * reading the blob at all.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { PUBLIC_SHEET_SCHEMAS } from '../store/public.js';

type SheetName = keyof typeof PUBLIC_SHEET_SCHEMAS;

function isSheetName(name: string): name is SheetName {
  return Object.hasOwn(PUBLIC_SHEET_SCHEMAS, name);
}

/**
 * Minimum-viable extension → Content-Type table. The set we care about
 * today is avatars + buzz images + the occasional PDF; unknown extensions
 * fall back to application/octet-stream (clients that need to render know
 * what they asked for).
 */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

function inferContentType(key: string): string {
  const dot = key.lastIndexOf('.');
  if (dot < 0 || dot === key.length - 1) return 'application/octet-stream';
  const ext = key.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Validate a wildcard-captured attachment key. Returns the key on success;
 * throws ApiValidationError on shape violations. Defense in depth — the key
 * only ever resolves inside a sheet's tree, but rejecting obviously-malformed
 * keys up front gives clearer error messages.
 */
function validateKey(raw: string): string {
  if (raw.length === 0) {
    throw new ApiValidationError('attachment key is required', { key: 'required' });
  }
  if (raw.startsWith('/')) {
    throw new ApiValidationError('attachment key must not start with /', { key: 'no_leading_slash' });
  }
  // Reject any control char or null byte. The eslint-disable is for the
  // explicit \x00-\x1f range — intentional precisely because we DO want
  // to catch control chars in keys (security-relevant input validation).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw new ApiValidationError('attachment key contains control characters', {
      key: 'invalid_chars',
    });
  }
  // Split on `/` and reject `..`, `.`, or empty segments (`//`, trailing `/`).
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ApiValidationError('attachment key contains an invalid segment', {
        key: 'invalid_path',
      });
    }
  }
  return raw;
}

export async function attachmentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/attachments/*',
    {
      schema: {
        tags: ['attachments'],
        summary: 'Serve a gitsheets attachment by its on-record key',
        // Wildcard params get folded into params['*']; document the response
        // shape but skip strict param validation (the route does its own).
        response: {
          200: { type: 'string', description: 'Binary blob.' },
        },
      },
    },
    async (request: FastifyRequest, reply) => {
      const raw = (request.params as Record<string, string>)['*'] ?? '';
      const key = validateKey(raw);

      // <sheet>/<record path>/<name>; the record path may itself contain `/`.
      const segments = key.split('/');
      const sheetName = segments[0] ?? '';
      if (segments.length < 3 || !isSheetName(sheetName)) {
        throw new ApiNotFoundError(`attachment not found: ${key}`);
      }
      const name = segments[segments.length - 1] as string;
      const recordPath = segments.slice(1, -1).join('/');

      const sheet = fastify.store.public[sheetName];
      const blob = await sheet.getAttachment(recordPath, name);
      if (!blob) throw new ApiNotFoundError(`attachment not found: ${key}`);

      const etag = `"${blob.hash}"`;
      reply
        .header('ETag', etag)
        .header('Cache-Control', 'public, max-age=3600');
      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }

      return reply.type(inferContentType(key)).send(await blob.read());
    },
  );
}
