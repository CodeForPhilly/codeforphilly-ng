/**
 * Internal-only routes.
 *
 * Currently houses the hot-reload webhook documented in
 * `specs/behaviors/storage.md#hot-reload`:
 *
 *   POST /api/_internal/reload-data
 *     - Hidden from the public OpenAPI doc (`schema.hide: true`)
 *     - Auth: `Authorization: Bearer <CFP_DATA_RELOAD_SECRET>` —
 *       constant-time compare, length-checked first to avoid a different
 *       early-exit timing side channel
 *     - Body: optional `{ branch?: string, commitHash?: string }`
 *     - Behavior:
 *         1. If `commitHash` is given AND already an ancestor of local
 *            HEAD, return 200 noChanges without touching the lock or
 *            the network (handles self-trigger from push-daemon pushes).
 *         2. Otherwise call `fastify.reconcileDataRepo({ branch })`
 *            under the data-repo lock.
 *         3. If outcome === 'in-sync', skip the rebuild and return
 *            200 noChanges.
 *         4. Otherwise rebuild the in-memory state + FTS index in place,
 *            invalidate the facet cache, and return 200 with
 *            `rebuilt: true`.
 *
 * The route is registered unconditionally — when `CFP_DATA_RELOAD_SECRET`
 * is unset, requests get a 503 at request time. This keeps the
 * deployment surface stable across environments that haven't been
 * configured for hot reloads yet.
 */
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { FastifyInstance } from 'fastify';

import { errorResponse, ok } from '../lib/response.js';
import { reloadInMemoryStateAndFts } from '../store/memory/reload.js';
import type { ReconcileOutcome } from '../store/reconcile.js';

const exec = promisify(execFile);

/** Bearer-token regex — case-insensitive, single whitespace separator. */
const BEARER_RE = /^Bearer\s+(\S+)$/i;

/**
 * Constant-time comparison of two strings. Returns false (without
 * decoding) when the lengths differ — comparing length is its own early
 * exit, but a length mismatch tells the attacker only the secret's
 * length, which we accept as a cheaper-than-real-world side channel.
 */
function safeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Buffer.from('utf8') for ASCII tokens has length === string length,
  // so the lengths still match; defensive guard anyway.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface ReloadBody {
  readonly branch?: string;
  readonly commitHash?: string;
}

const reloadBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    branch: { type: 'string', minLength: 1, maxLength: 200 },
    commitHash: {
      type: 'string',
      // git supports abbreviated SHAs; allow 4-40 hex chars
      pattern: '^[0-9a-fA-F]{4,40}$',
    },
  },
} as const;

export async function internalRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ReloadBody | undefined }>(
    '/api/_internal/reload-data',
    {
      schema: {
        hide: true,
        body: reloadBodySchema,
      },
    },
    async (request, reply) => {
      const traceId = (request as typeof request & { traceId?: string }).traceId;
      const expected = fastify.config.CFP_DATA_RELOAD_SECRET;

      // ---- Bearer auth (route refuses to do anything before this passes) ----
      const headerValue = request.headers['authorization'];
      const headerStr = Array.isArray(headerValue) ? headerValue[0] : headerValue;
      const match = typeof headerStr === 'string' ? BEARER_RE.exec(headerStr) : null;
      const provided = match?.[1];

      if (!provided) {
        return reply
          .code(401)
          .send(errorResponse('unauthorized', 'Authentication required', traceId));
      }

      // 503 takes precedence over a token-match check ONLY when the
      // operator hasn't even configured the secret. We still return 401
      // on a missing/empty header BEFORE checking the secret so that
      // unauthenticated probes don't get a different status code
      // depending on whether the env var is set. Order matters: header
      // present → check secret configured → check token equality.
      if (!expected) {
        return reply.code(503).send(
          errorResponse(
            'service_unavailable',
            'hot-reload not configured',
            traceId,
          ),
        );
      }

      if (!safeEqualStrings(provided, expected)) {
        return reply
          .code(401)
          .send(errorResponse('unauthorized', 'Authentication required', traceId));
      }

      // ---- Resolve effective branch ----
      const body: ReloadBody = request.body ?? {};
      const branch = body.branch ?? fastify.config.CFP_DATA_BRANCH;
      if (!branch) {
        return reply
          .code(400)
          .send(
            errorResponse(
              'bad_request',
              'branch is required when CFP_DATA_BRANCH is unset',
              traceId,
            ),
          );
      }

      const startedAt = Date.now();
      const repoPath = fastify.config.CFP_DATA_REPO_PATH;
      const commitHash = body.commitHash;

      // ---- Cheap pre-check: is `commitHash` already in local HEAD? ----
      // No lock acquired here — `merge-base --is-ancestor` only reads
      // git's object store, which is safe alongside an in-flight
      // gitsheets transact. Worst case (a transact lands between this
      // check and the answer being read) we accept a stale "no" and
      // proceed to the full reconcile.
      if (commitHash) {
        try {
          const head = (
            await exec('git', ['rev-parse', 'HEAD'], { cwd: repoPath })
          ).stdout.trim();
          await exec(
            'git',
            ['merge-base', '--is-ancestor', commitHash, head],
            { cwd: repoPath },
          );
          // `git merge-base --is-ancestor` exits 0 = is-ancestor, 1 = not.
          // Reaching here means exit 0; short-circuit.
          fastify.log.info(
            { branch, commitHash, head },
            'hot-reload short-circuit: commit already in local HEAD',
          );
          return reply.send(
            ok({
              noChanges: true,
              outcome: 'in-sync' as ReconcileOutcome,
              head,
              durationMs: Date.now() - startedAt,
            }),
          );
        } catch (err) {
          // exec throws with `code: 1` when not-ancestor (continue to
          // reconcile) and with other codes when the commit is unknown
          // or git itself fails. We treat all non-zero as "fall through
          // to reconcile" — the reconcile will fetch and try again.
          fastify.log.debug(
            {
              err: err instanceof Error ? err.message : String(err),
              branch,
              commitHash,
            },
            'hot-reload pre-check fell through to full reconcile',
          );
        }
      }

      // ---- Reconcile under the data-repo lock ----
      const result = await fastify.reconcileDataRepo({ branch });

      if (result.outcome === 'in-sync') {
        fastify.log.info(
          { branch, commit: result.newCommit, outcome: result.outcome },
          'hot-reload: nothing to do (in-sync after fetch)',
        );
        return reply.send(
          ok({
            noChanges: true,
            outcome: result.outcome,
            oldCommit: result.oldCommit,
            newCommit: result.newCommit,
            durationMs: Date.now() - startedAt,
          }),
        );
      }

      // ---- Rebuild ----
      try {
        await reloadInMemoryStateAndFts(fastify);
      } catch (err) {
        // The in-memory state + FTS index may be partially mutated.
        // Log loudly so the operator knows a pod restart is warranted,
        // then 500 the request.
        fastify.log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            branch,
            outcome: result.outcome,
            oldCommit: result.oldCommit,
            newCommit: result.newCommit,
          },
          'hot-reload: in-memory rebuild failed AFTER reconcile — pod is in an undefined state, restart required',
        );
        return reply.code(500).send(
          errorResponse(
            'internal_error',
            'Hot-reload rebuild failed — pod restart required',
            traceId,
          ),
        );
      }

      const durationMs = Date.now() - startedAt;
      fastify.log.info(
        {
          branch,
          outcome: result.outcome,
          oldCommit: result.oldCommit,
          newCommit: result.newCommit,
          conflictBranch: result.conflictBranch,
          durationMs,
        },
        'hot-reload: in-memory state + FTS rebuilt',
      );

      return reply.send(
        ok({
          noChanges: false,
          rebuilt: true,
          outcome: result.outcome,
          oldCommit: result.oldCommit,
          newCommit: result.newCommit,
          ...(result.conflictBranch ? { conflictBranch: result.conflictBranch } : {}),
          durationMs,
        }),
      );
    },
  );
}
