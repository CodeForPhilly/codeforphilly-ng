/**
 * In-memory rate-limit plugin.
 *
 * Enforces per-IP and per-account caps per specs/api/conventions.md#rate-limiting:
 *   - Unauthenticated reads:  1200 req / min / IP
 *   - Authenticated reads:     300 req / min / account
 *   - Writes:                   30 req / min / account (120 / min / IP anonymous)
 *   - Credential endpoints:    120 req / min / IP
 *
 * Only `/api/**` is counted. The SPA shell, its assets, and thumbnails come out
 * of the same process and a single page load fetches dozens of them; counting
 * those against the read cap is what produced a site-wide 429 storm at cutover.
 *
 * Per-IP caps are generous on purpose: production's load balancer does not yet
 * preserve client addresses (cfp-live-cluster #201), so every visitor shares
 * one "IP" until that lands.
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

export const RATE_LIMITS = {
  unauthenticatedReadsPerIp: 1200,
  authenticatedReadsPerAccount: 300,
  writesPerAccount: 30,
  anonymousWritesPerIp: 120,
  credentialPerIp: 120,
} as const;

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
const API_PREFIX = '/api/';

/**
 * Routes that accept or mint a credential. Session reads (`/api/auth/me`,
 * `/api/auth/refresh`, `/api/auth/sessions`, `/api/auth/logout`) are ordinary
 * traffic — `/me` runs on every page load.
 */
const CREDENTIAL_PATHS = [
  '/api/auth/login',
  '/api/auth/github/start',
  '/api/auth/github/callback',
  '/api/auth/link-github',
  '/api/auth/password-reset/',
  '/api/account-claim/by-password',
];

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function isCredentialPath(path: string): boolean {
  return CREDENTIAL_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

async function rateLimitPlugin(fastify: FastifyInstance): Promise<void> {
  const ipBuckets = new Map<string, BucketEntry>();
  const accountBuckets = new Map<string, BucketEntry>();

  fastify.addHook('onRequest', (request, _reply, done) => {
    try {
      const path = pathOf(request.url);
      if (!path.startsWith(API_PREFIX)) {
        done();
        return;
      }

      const ip = clientIp(request);
      const isWrite = WRITE_METHODS.has(request.method);
      const personId = request.session?.person?.id;

      if (isCredentialPath(path)) {
        check(ipBuckets, `credential:${ip}`, RATE_LIMITS.credentialPerIp);
      } else if (isWrite) {
        if (personId) {
          check(accountBuckets, `write-account:${personId}`, RATE_LIMITS.writesPerAccount);
        } else {
          check(ipBuckets, `write:${ip}`, RATE_LIMITS.anonymousWritesPerIp);
        }
      } else {
        if (personId) {
          check(accountBuckets, `account:${personId}`, RATE_LIMITS.authenticatedReadsPerAccount);
        } else {
          check(ipBuckets, `read:${ip}`, RATE_LIMITS.unauthenticatedReadsPerIp);
        }
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
