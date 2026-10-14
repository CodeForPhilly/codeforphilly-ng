/**
 * Slug-history redirect plugin.
 *
 * Serves 301s for non-expired SlugHistory entries per
 * specs/behaviors/slug-handles.md → "Mutability and redirects". Pattern-
 * matches the slug-bearing SPA paths on every non-/api/* GET; for live-
 * missing slugs that have a SlugHistory entry, redirects to the canonical
 * URL with the suffix preserved.
 *
 * Spec edge cases handled:
 *   - **Live wins** — if `oldSlug` is currently a live entity of the same
 *     type (someone took the freed slug), no redirect.
 *   - **Multi-hop chains** — A → B → C resolves to C in one response via
 *     in-process chain follow, capped at MAX_HOPS to short-circuit
 *     pathological inputs.
 *   - **Expired entries** — past-`expiresAt` records are dropped at index
 *     time (`indexSlugHistory`) so the lookup naturally misses.
 *   - **Tag namespace** — `/tags/:namespace/:slug` rewrites the slug while
 *     preserving the namespace; the SlugHistory key is `tag:<slug>`
 *     regardless of namespace (matches the schema's lookup shape).
 *
 * Plugin order: registered after `services` (decorates `inMemoryState`)
 * and before `static-web` (which owns the SPA fallthrough notFoundHandler).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { normalizeLegacyHandle, type LegacyHandleEntity } from '@cfp/shared';

import { slugHistoryKey, type InMemoryState } from '../store/memory/state.js';

const MAX_HOPS = 8;

type EntityType = LegacyHandleEntity;

/**
 * Pattern descriptor for a slug-bearing path. Each pattern declares the
 * regex that extracts the slug component(s) and a function that rebuilds
 * the URL once we've resolved any renames.
 */
interface RoutePattern {
  /** Entity type that the slug-history lookup keys on. */
  readonly entityType: EntityType;
  /**
   * Regex against `path` (origin-relative; query stripped). Must contain a
   * single capture group for the slug component, except `tag` which captures
   * (namespace, slug).
   */
  readonly match: RegExp;
  /** Live-entity check — returns the canonical slug if this slug is live, else null. */
  readonly liveIndex: (state: InMemoryState, slug: string) => boolean;
  /** Rebuild the path with the resolved slug substituted in place of the original. */
  readonly rebuild: (match: RegExpExecArray, resolvedSlug: string) => string;
}

const patterns: readonly RoutePattern[] = [
  // /projects/<slug>/buzz/<buzzSlug>... — both legs are renamable. The deeper
  // match runs first so we attempt to resolve both buzz and project; either
  // can independently redirect.
  // (Currently no slug-history writer for buzz, but the spec includes 'buzz'
  // in SlugHistory.entityType so the plumbing supports it.) Buzz slugs are
  // unique across all projects, so `buzzIdBySlug` is the live check.
  {
    entityType: 'buzz',
    match: /^\/projects\/([^/]+)\/buzz\/([^/]+)(\/.*)?$/,
    liveIndex: (state, slug) => state.buzzIdBySlug.has(slug),
    rebuild: (m, resolved) => `/projects/${m[1]}/buzz/${resolved}${m[3] ?? ''}`,
  },
  {
    entityType: 'project',
    match: /^\/projects\/([^/]+)(\/.*)?$/,
    liveIndex: (state, slug) => state.projectIdBySlug.has(slug),
    rebuild: (m, resolved) => `/projects/${resolved}${m[2] ?? ''}`,
  },
  {
    entityType: 'person',
    match: /^\/members\/([^/]+)(\/.*)?$/,
    liveIndex: (state, slug) => state.personIdBySlug.has(slug),
    rebuild: (m, resolved) => `/members/${resolved}${m[2] ?? ''}`,
  },
  {
    entityType: 'event_series',
    // Before the event pattern so `/events/series/<slug>` resolves as a series.
    match: /^\/events\/series\/([^/]+)(\/.*)?$/,
    liveIndex: (state, slug) => state.eventSeriesIdBySlug.has(slug),
    rebuild: (m, resolved) => `/events/series/${resolved}${m[2] ?? ''}`,
  },
  {
    entityType: 'event',
    // `/events/past`, `/events/new`, `/events/series/…` fall through: they're
    // never live event slugs and never in slug-history.
    match: /^\/events\/([^/]+)(\/.*)?$/,
    liveIndex: (state, slug) => state.eventIdBySlug.has(slug),
    rebuild: (m, resolved) => `/events/${resolved}${m[2] ?? ''}`,
  },
  {
    entityType: 'tag',
    // Capture namespace + slug; namespace stays unchanged in the rebuild.
    match: /^\/tags\/([^/]+)\/([^/]+)(\/.*)?$/,
    liveIndex: (state, slug) => {
      // Tags are uniquely keyed by `(namespace, slug)`; we look up `tag:<slug>`
      // in slug-history regardless of namespace. Live-check checks any
      // namespace match — if the slug is in use by ANY namespace it counts
      // as "live wins". Tags rarely collide across namespaces so this is
      // conservative.
      for (const handle of state.tagIdByHandle.keys()) {
        if (handle.endsWith(`.${slug}`)) return true;
      }
      return false;
    },
    rebuild: (m, resolved) => `/tags/${m[1]}/${resolved}${m[3] ?? ''}`,
  },
];

/**
 * Follow the slug-history chain in-process up to MAX_HOPS, stopping at the
 * first slug that is live (or absent from slug-history). Returns null when
 * no rewriting is needed (slug already live, or no slug-history entry, or
 * the chain bottoms out at the same slug).
 */
function followHistory(
  state: InMemoryState,
  pattern: RoutePattern,
  startSlug: string,
): string | null {
  let current = startSlug;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const entry = state.slugHistory.get(slugHistoryKey(pattern.entityType, current));
    if (!entry) {
      // No more slug-history to follow. Return null if we never moved.
      return current === startSlug ? null : current;
    }
    if (entry.newSlug === current) {
      // Defensive: pathological self-loop.
      return current === startSlug ? null : current;
    }
    current = entry.newSlug;
    // If the chain has reached a live slug, we're done — return it.
    if (pattern.liveIndex(state, current)) return current;
  }
  // Chain too long — log + bail. The first hop's destination is what we return.
  return current === startSlug ? null : current;
}

interface Resolution {
  readonly slug: string;
  /** True for a legacy-normalization hit, which never expires. */
  readonly permanent: boolean;
}

/**
 * Resolve a non-live slug: slug-history first, then the legacy handle
 * normalization (specs/behaviors/slug-handles.md → "Legacy handle
 * normalization"), which only redirects when the normalized slug is live or
 * itself resolves through slug-history.
 */
function resolveSlug(
  state: InMemoryState,
  pattern: RoutePattern,
  startSlug: string,
): Resolution | null {
  // Live first — never redirect away from a slug that's currently a real entity.
  if (pattern.liveIndex(state, startSlug)) return null;

  const viaHistory = followHistory(state, pattern, startSlug);
  if (viaHistory !== null) return { slug: viaHistory, permanent: false };

  const normalized = normalizeLegacyHandle(safeDecode(startSlug), pattern.entityType);
  if (normalized === '' || normalized === startSlug) return null;
  if (pattern.liveIndex(state, normalized)) return { slug: normalized, permanent: true };
  const normalizedViaHistory = followHistory(state, pattern, normalized);
  return normalizedViaHistory !== null ? { slug: normalizedViaHistory, permanent: false } : null;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function slugRedirectPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return;
    // Strip query before pattern-matching; preserve it for the rebuilt URL.
    const url = request.url;
    if (url.startsWith('/api/')) return;
    const queryIdx = url.indexOf('?');
    const path = queryIdx === -1 ? url : url.slice(0, queryIdx);
    const query = queryIdx === -1 ? '' : url.slice(queryIdx);

    const state = fastify.inMemoryState;

    for (const pattern of patterns) {
      const m = pattern.match.exec(path);
      if (!m) continue;
      // For the tag pattern the captured slug is in group 2; everywhere else
      // it's group 1. (Buzz pattern's renamable leg is also group 2.)
      const slugGroup = pattern.entityType === 'tag' || pattern.entityType === 'buzz' ? 2 : 1;
      const slug = m[slugGroup];
      if (!slug) continue;

      const resolved = resolveSlug(state, pattern, slug);
      if (!resolved) continue;

      const newPath = pattern.rebuild(m, resolved.slug);
      const target = newPath + query;
      // Slug-history redirects get a 5-minute cache: they expire when the
      // 90-day window does, so a short cache avoids lying to clients about a
      // permanent-looking redirect. Legacy-normalization redirects never
      // expire and can be cached for a day.
      await reply
        .code(301)
        .header('Location', target)
        .header('Cache-Control', `public, max-age=${resolved.permanent ? 86400 : 300}`)
        .send();
      return;
    }
  });
}

export default fp(slugRedirectPlugin, {
  name: 'slug-redirect',
  dependencies: ['services'],
});
