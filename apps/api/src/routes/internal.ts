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
 *     - Body: optional `{ branch?: string, commitHash?: string }`; a
 *       `branch` other than `CFP_DATA_BRANCH` is rejected with 400
 *     - Behavior:
 *         1. If `commitHash` is given AND already an ancestor of local
 *            HEAD, return 200 noChanges without touching the lock or
 *            the network (handles self-trigger from push-daemon pushes).
 *         2. Otherwise call `fastify.reconcileDataRepo()`, which fetches,
 *            then reconciles under the repository write lock.
 *         3. If the reconcile moved the branch, rebuild the in-memory
 *            state + FTS index in place inside that same lock (so no write
 *            can land between the ref move and the swap) and return 200
 *            with `rebuilt: true`; otherwise return 200 noChanges.
 *
 * The route is registered unconditionally — when `CFP_DATA_RELOAD_SECRET`
 * is unset, requests get a 503 at request time. This keeps the
 * deployment surface stable across environments that haven't been
 * configured for hot reloads yet.
 */
import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { errorResponse, ok } from '../lib/response.js';
import { reloadInMemoryStateAndFts, type ReloadMode } from '../store/memory/reload.js';
import type { ReconcileOutcome, ReconcileResult } from '../store/reconcile.js';

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
      // Only the served branch can be reconciled: the public store reads
      // HEAD, so reconciling any other ref would desync silently.
      const body: ReloadBody = request.body ?? {};
      const branch = fastify.config.CFP_DATA_BRANCH;
      if (!branch) {
        return reply
          .code(400)
          .send(errorResponse('bad_request', 'CFP_DATA_BRANCH is unset', traceId));
      }
      if (body.branch !== undefined && body.branch !== branch) {
        return reply
          .code(400)
          .send(
            errorResponse(
              'bad_request',
              `branch must be the served branch (${branch})`,
              traceId,
            ),
          );
      }

      const startedAt = Date.now();
      const commitHash = body.commitHash;

      // ---- Cheap pre-check: is `commitHash` already in local HEAD? ----
      // No lock acquired here — `repo.isAncestor` only reads git's object
      // store, which is safe alongside an in-flight gitsheets transact.
      // Worst case (a transact lands between resolving HEAD and the answer
      // being read) we accept a stale "no" and proceed to the full
      // reconcile.
      if (commitHash) {
        try {
          const head = await fastify.publicRepo.resolveRef('HEAD');
          if (head && (await fastify.publicRepo.isAncestor(commitHash, head))) {
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
          }
        } catch (err) {
          // RefError when the commit isn't in the local object store yet
          // (the usual case for an upstream push). Fall through to the
          // reconcile, which fetches and tries again.
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

      // ---- Reconcile + rebuild under the repository write lock ----
      let result: ReconcileResult;
      let reloadMode: ReloadMode | undefined;
      try {
        result = await fastify.reconcileDataRepo({
          onMoved: async (moved) => {
            reloadMode = await reloadInMemoryStateAndFts(fastify, { fromCommit: moved.oldCommit });
          },
        });
      } catch (err) {
        // A throw from the rebuild leaves the in-memory state + FTS index
        // possibly partially mutated. Log loudly so the operator knows a
        // pod restart is warranted, then 500 the request.
        fastify.log.error(
          { err: err instanceof Error ? err.message : String(err), branch },
          'hot-reload: reconcile or in-memory rebuild failed — pod may be in an undefined state, restart required',
        );
        return reply.code(500).send(
          errorResponse(
            'internal_error',
            'Hot-reload rebuild failed — pod restart required',
            traceId,
          ),
        );
      }

      if (result.newCommit === result.oldCommit) {
        fastify.log.info(
          { branch, commit: result.newCommit, outcome: result.outcome },
          'hot-reload: nothing to rebuild (branch did not move)',
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

      const durationMs = Date.now() - startedAt;
      fastify.log.info(
        {
          branch,
          outcome: result.outcome,
          oldCommit: result.oldCommit,
          newCommit: result.newCommit,
          conflictBranch: result.conflictBranch,
          reloadMode,
          durationMs,
        },
        'hot-reload: in-memory state + FTS rebuilt',
      );

      return reply.send(
        ok({
          noChanges: false,
          rebuilt: true,
          reloadMode,
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
