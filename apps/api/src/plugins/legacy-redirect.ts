/**
 * Legacy laddr URL redirect plugin.
 *
 * Catches the URL shapes the old `codeforphilly.org` site served and
 * 301s them to the current canonical equivalents, per
 * specs/behaviors/legacy-id-mapping.md → "Legacy URL forms we accept".
 *
 *   /projects?ID=<n>                  → /projects/<slug>
 *   /people/:username[/...]           → /members/:username[/...]
 *   /project-updates?ProjectID=<n>    → /projects/<slug>
 *   /project-buzz/<slug>[/...]        → /projects/<projectSlug>/buzz/<slug>[/...]
 *   /tags/<namespace>.<slug>[/...]    → /tags/<namespace>/<slug>[/...]
 *
 * Plus `410 Gone` for explicitly-deferred patterns (`/checkin`,
 * `/bigscreen`) — see specs/deferred.md for why.
 *
 * Companion to slug-redirect.ts (renames *within* the new site). The two
 * hooks pattern-match disjoint URL shapes — they coexist without
 * coordination, both bypass /api/*, and both register before the
 * static-web SPA fallthrough.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import type { InMemoryState } from '../store/memory/state.js';

/** Long cache — legacy URL shapes are permanent. */
const REDIRECT_CACHE = 'public, max-age=86400';

/** 410 body — minimal explanation page. */
const GONE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>This page is no longer available</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 1.5rem; }
    p { line-height: 1.5; }
    a { color: #0366d6; }
  </style>
</head>
<body>
  <h1>This page is no longer available</h1>
  <p>
    The page you're looking for was part of an older version of
    <a href="https://codeforphilly.org/">codeforphilly.org</a> that's been
    retired. The feature isn't coming back in its old form, but you can
    still find current Code for Philly projects, events, and people from
    <a href="/">the home page</a>.
  </p>
</body>
</html>`;

const GONE_PATHS = new Set(['/checkin', '/bigscreen']);

/** Strip the query off a URL string, returning { path, query } (query keeps the leading ?). */
function splitUrl(url: string): { path: string; query: string } {
  const idx = url.indexOf('?');
  if (idx === -1) return { path: url, query: '' };
  return { path: url.slice(0, idx), query: url.slice(idx) };
}

/**
 * Remove a single query-string parameter while preserving the rest. Returns
 * the query suffix including the leading `?`, or '' if no params remain.
 */
function dropQueryParam(query: string, param: string): string {
  if (!query) return '';
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  params.delete(param);
  const remaining = params.toString();
  return remaining ? `?${remaining}` : '';
}

async function legacyRedirectPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return;
    if (request.url.startsWith('/api/')) return;

    const { path, query } = splitUrl(request.url);
    const state = fastify.inMemoryState;

    // /checkin, /bigscreen → 410 Gone -----------------------------------------
    if (GONE_PATHS.has(path)) {
      await reply
        .code(410)
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'public, max-age=86400')
        .send(GONE_HTML);
      return;
    }

    // /projects?ID=<n> → /projects/<slug> -------------------------------------
    if (path === '/projects' && query) {
      const id = legacyIdFromQuery(query, 'ID');
      if (id !== null) {
        const slug = projectSlugByLegacyId(state, id);
        if (slug) {
          const remainingQuery = dropQueryParam(query, 'ID');
          await sendRedirect(reply, `/projects/${slug}${remainingQuery}`);
          return;
        }
        // Unknown legacyId — fall through to SPA; nothing useful to redirect to.
      }
    }

    // /project-updates?ProjectID=<n> → /projects/<slug> -----------------------
    if (path === '/project-updates' && query) {
      const id = legacyIdFromQuery(query, 'ProjectID');
      if (id !== null) {
        const slug = projectSlugByLegacyId(state, id);
        if (slug) {
          const remainingQuery = dropQueryParam(query, 'ProjectID');
          await sendRedirect(reply, `/projects/${slug}${remainingQuery}`);
          return;
        }
      }
    }

    // /people/<username>[/...] → /members/<username>[/...] --------------------
    // Pure prefix rewrite — laddr's Username was copied verbatim into slug
    // per behaviors/slug-handles.md#migration-from-laddr, so no lookup needed.
    const peopleMatch = /^\/people\/([^/]+)(\/.*)?$/.exec(path);
    if (peopleMatch) {
      const username = peopleMatch[1] as string;
      const suffix = peopleMatch[2] ?? '';
      await sendRedirect(reply, `/members/${username}${suffix}${query}`);
      return;
    }

    // /project-buzz/<slug>[/...] → /projects/<projectSlug>/buzz/<slug>[/...] --
    const buzzMatch = /^\/project-buzz\/([^/]+)(\/.*)?$/.exec(path);
    if (buzzMatch) {
      const buzzSlug = buzzMatch[1] as string;
      const suffix = buzzMatch[2] ?? '';
      const buzzId = state.buzzIdBySlug.get(buzzSlug);
      if (buzzId !== undefined) {
        const buzz = state.projectBuzz.get(buzzId);
        if (buzz) {
          const projectSlug = state.projectSlugById.get(buzz.projectId);
          if (projectSlug) {
            await sendRedirect(
              reply,
              `/projects/${projectSlug}/buzz/${buzzSlug}${suffix}${query}`,
            );
            return;
          }
        }
      }
      // Unknown buzz slug — fall through (SPA serves 404 or its own handling).
    }

    // /tags/<namespace>.<slug>[/...] → /tags/<namespace>/<slug>[/...] ---------
    // Pure URL transform; no lookup. The legacy dot-form was laddr's tag
    // handle shape; the new site uses path-form for routing distinction.
    const dotTagMatch = /^\/tags\/([a-z]+)\.([^/]+)(\/.*)?$/.exec(path);
    if (dotTagMatch) {
      const namespace = dotTagMatch[1] as string;
      const slug = dotTagMatch[2] as string;
      const suffix = dotTagMatch[3] ?? '';
      await sendRedirect(reply, `/tags/${namespace}/${slug}${suffix}${query}`);
      return;
    }
  });
}

async function sendRedirect(reply: FastifyReply, target: string): Promise<void> {
  await reply
    .code(301)
    .header('Location', target)
    .header('Cache-Control', REDIRECT_CACHE)
    .send();
}

/**
 * Parse an integer legacy-id from a query string. Returns null for absent,
 * non-numeric, negative, or NaN values — those fall through to the SPA
 * rather than triggering a redirect to an invalid target.
 */
function legacyIdFromQuery(query: string, param: string): number | null {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const raw = params.get(param);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function projectSlugByLegacyId(state: InMemoryState, legacyId: number): string | null {
  const projectId = state.projectIdByLegacyId.get(legacyId);
  if (!projectId) return null;
  return state.projectSlugById.get(projectId) ?? null;
}

export default fp(legacyRedirectPlugin, {
  name: 'legacy-redirect',
  dependencies: ['services'],
});
