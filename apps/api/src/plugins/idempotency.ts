/**
 * Idempotency-key plugin.
 *
 * Mutating endpoints may send an `Idempotency-Key` header. If the API has
 * already processed a request with the same (personId, key) pair within 24h,
 * it replays the cached response without re-running the handler.
 *
 * In-memory by design (single replica). Per specs/api/conventions.md#idempotency.
 *
 * Usage from route handlers:
 *   const cached = fastify.idempotency.check(personId, key);
 *   if (cached) return reply.status(cached.status).send(cached.body);
 *   // ... run handler ...
 *   fastify.idempotency.store(personId, key, { status: 201, body: result });
 *
 * The hook on preHandler only sets up the check helper; actual cache reads and
 * writes happen inside the route handler so each route controls the scope.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface CachedResponse {
  readonly status: number;
  readonly body: unknown;
  readonly cachedAt: number;
}

interface IdempotencyStore {
  /**
   * Check if a response is cached for this (personId, key) pair.
   * Returns undefined if not cached or if the cache entry has expired.
   */
  check(personId: string, key: string): CachedResponse | undefined;

  /**
   * Cache the response for this (personId, key) pair.
   */
  store(personId: string, key: string, response: Omit<CachedResponse, 'cachedAt'>): void;
}

async function idempotencyPlugin(fastify: FastifyInstance): Promise<void> {
  const cache = new Map<string, CachedResponse>();

  function cacheKey(personId: string, key: string): string {
    return `${personId}:${key}`;
  }

  function evictExpired(): void {
    const now = Date.now();
    for (const [k, entry] of cache) {
      if (now - entry.cachedAt >= TTL_MS) {
        cache.delete(k);
      }
    }
  }

  const idempotency: IdempotencyStore = {
    check(personId, key) {
      const entry = cache.get(cacheKey(personId, key));
      if (!entry) return undefined;
      if (Date.now() - entry.cachedAt >= TTL_MS) {
        cache.delete(cacheKey(personId, key));
        return undefined;
      }
      return entry;
    },

    store(personId, key, response) {
      // Evict stale entries periodically (on every store call)
      evictExpired();
      cache.set(cacheKey(personId, key), { ...response, cachedAt: Date.now() });
    },
  };

  fastify.decorate('idempotency', idempotency);
}

declare module 'fastify' {
  interface FastifyInstance {
    idempotency: {
      check(personId: string, key: string): CachedResponse | undefined;
      store(personId: string, key: string, response: Omit<CachedResponse, 'cachedAt'>): void;
    };
  }
}

export default fp(idempotencyPlugin, {
  name: 'idempotency',
  fastify: '5.x',
});
