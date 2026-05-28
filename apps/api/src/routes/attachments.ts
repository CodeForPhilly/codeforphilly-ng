/**
 * Attachment serving.
 *
 *   GET /api/attachments/*  →  stream the gitsheets attachment at the
 *                              path captured by the wildcard segment
 *
 * Reads via `git cat-file blob HEAD:<key>` against the bare data clone,
 * piping stdout directly into the Fastify reply for streaming. Per
 * specs/behaviors/storage.md → "Attachments": "Web serves attachments
 * via a streamed GET /api/attachments/<key> route with cache headers."
 *
 * Bypasses gitsheets' `Sheet.getAttachment()` API in favor of direct git
 * plumbing because:
 *   1. The attachment key IS the HEAD-tree path (per spec) — parsing it
 *      back into (sheet, record, name) and re-resolving via the sheet API
 *      is redundant.
 *   2. Standing Sheet handles cache `dataTree` at openStore time
 *      (documented in storage.md → "Direct gitsheets reads after a
 *      transact"); plumbing reads from current HEAD on every request,
 *      so attachment updates are visible immediately without a
 *      Store.swapPublic().
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { spawn } from 'node:child_process';

import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';

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
 * throws ApiValidationError on shape violations. Defense in depth — git
 * cat-file with a ref:path argument is itself resistant to shell exploits
 * (no shell interpolation; the path is a single argv), but rejecting
 * obviously-malformed keys up front gives clearer error messages and
 * sidesteps any sheet/path-template-related edge cases.
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
  const repoPath = fastify.config.CFP_DATA_REPO_PATH;

  fastify.get(
    '/api/attachments/*',
    {
      schema: {
        tags: ['attachments'],
        summary: 'Serve a gitsheets attachment by its on-record key',
        // Wildcard params get folded into params['*']; document the response
        // shape but skip strict param validation (the route does its own).
        response: {
          200: { type: 'string', description: 'Binary blob; streamed as the response body.' },
        },
      },
    },
    async (request: FastifyRequest, reply) => {
      const raw = (request.params as Record<string, string>)['*'] ?? '';
      const key = validateKey(raw);

      // `git cat-file blob HEAD:<path>` writes the blob to stdout and exits
      // 0 on success, non-zero (with a "fatal:" message on stderr) if the
      // path doesn't resolve in HEAD. We branch on exit code below.
      const child = spawn('git', ['cat-file', 'blob', `HEAD:${key}`], {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stderrChunks: Buffer[] = [];
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      // Wait for either:
      //   - first stdout data → success, set headers and pipe
      //   - exit before any stdout → failure, translate to 4xx/5xx
      // Race-style with a single resolve.
      const exited = new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? -1));
      });

      const firstData = new Promise<Buffer | null>((resolve) => {
        let resolved = false;
        const onData = (chunk: Buffer): void => {
          if (!resolved) {
            resolved = true;
            child.stdout.off('data', onData);
            resolve(chunk);
          }
        };
        child.stdout.on('data', onData);
        // If the child exits without ever emitting stdout, resolve null.
        child.on('close', () => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        });
      });

      const first = await firstData;
      if (first === null) {
        const code = await exited;
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        // git cat-file's stderr for a missing path looks like:
        //   fatal: path '<key>' does not exist in 'HEAD'
        //   fatal: Not a valid object name HEAD:<key>
        // Both are 404-shaped; any other non-zero exit is unexpected.
        if (code !== 0 && /not (?:a valid|exist)|fatal:/i.test(stderr)) {
          throw new ApiNotFoundError(`attachment not found: ${key}`);
        }
        throw new Error(`git cat-file failed (exit ${code}): ${stderr || 'no stderr'}`);
      }

      // First chunk arrived → take over the raw response so we can write
      // the buffered first chunk + pipe the rest. `reply.hijack()` tells
      // Fastify "I'll send the response myself" — headers must be set
      // directly on reply.raw from this point on.
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': inferContentType(key),
        'Cache-Control': 'public, max-age=3600',
      });
      reply.raw.write(first);
      child.stdout.pipe(reply.raw);

      // Resolve when the child finishes flushing — without this, Fastify's
      // handler-promise resolves immediately and may close the socket.
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('end', () => resolve());
        child.on('error', reject);
      });
    },
  );
}
