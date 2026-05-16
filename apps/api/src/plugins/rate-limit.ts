/**
 * In-memory rate-limit plugin.
 *
 * Enforces per-IP and per-account caps per specs/api/conventions.md#rate-limiting:
 *   - Unauthenticated reads: 60 req / min / IP
 *   - Authenticated reads:  300 req / min / account
 *   - Writes:                30 req / min / account
 *   - Auth endpoints:        10 req / min / IP
 *
 * Counters are reset on restart (intentional — single replica, civic scale).
 * Exceeded limit → RateLimitedError(retryAfterSeconds).
 *
 * The error mapper in errors.ts converts RateLimitedError to 429 + Retry-After.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { RateLimitedError } from '../lib/errors.js';

interface BucketEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000; // 1 minute

function getOrCreate(map: Map<string, BucketEntry>, key: string): BucketEntry {
  let entry = map.get(key);
  if (!entry) {
    entry = { count: 0, windowStart: Date.now() };
    map.set(key, entry);
  }
  return entry;
}

function check(map: Map<string, BucketEntry>, key: string, limit: number): void {
  const now = Date.now();
  const entry = getOrCreate(map, key);

  if (now - entry.windowStart >= WINDOW_MS) {
    // New window
    entry.count = 1;
    entry.windowStart = now;
    return;
  }

  entry.count += 1;
  if (entry.count > limit) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);
    throw new RateLimitedError(retryAfter);
  }
}

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0];
    return (first ?? '').trim();
  }
  return request.socket?.remoteAddress ?? 'unknown';
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_PATH_PREFIX = '/api/auth';

async function rateLimitPlugin(fastify: FastifyInstance): Promise<void> {
  const ipBuckets = new Map<string, BucketEntry>();
  const accountBuckets = new Map<string, BucketEntry>();

  fastify.addHook('onRequest', (request, _reply, done) => {
    try {
      const ip = clientIp(request);
      const isWrite = WRITE_METHODS.has(request.method);
      const isAuthEndpoint = request.url.startsWith(AUTH_PATH_PREFIX);

      if (isAuthEndpoint) {
        // Auth endpoints: 10 req / min / IP
        check(ipBuckets, `auth:${ip}`, 10);
      } else if (isWrite) {
        // Writes: keyed by account if we have one, otherwise IP
        // (Account ID is not available until auth lands; use IP for now)
        check(ipBuckets, `write:${ip}`, 30);
      } else {
        // Reads: unauthenticated=60/min/IP, authenticated=300/min/account
        // Account check will be wired by auth-jwt-substrate plan
        check(ipBuckets, `read:${ip}`, 60);
      }
    } catch (err) {
      done(err as Error);
      return;
    }
    done();
  });

  // Expose the buckets for testing
  fastify.decorate('rateLimitBuckets', { ip: ipBuckets, account: accountBuckets });
}

declare module 'fastify' {
  interface FastifyInstance {
    rateLimitBuckets: {
      ip: Map<string, BucketEntry>;
      account: Map<string, BucketEntry>;
    };
  }
}

export default fp(rateLimitPlugin, {
  name: 'rate-limit',
  fastify: '5.x',
});
