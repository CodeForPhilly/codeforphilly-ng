/**
 * Markdown plugin.
 *
 * Installs a `renderMarkdown` implementation into
 * `apps/api/src/services/serializers/common.ts` that closes over:
 *
 *   - `CFP_SITE_HOST` (from env) — used by the external-link transform
 *     to decide which anchors get `target="_blank" rel="noopener nofollow"`.
 *   - `inMemoryState.personIdBySlug.has` — used by the `@mention` transform
 *     to resolve which usernames link to a real Person.
 *
 * Every serializer renders markdown via `common.renderMarkdown`, which
 * dispatches to whichever function this plugin most recently installed.
 * Until installed (tests, ad-hoc scripts), it falls back to the bare
 * `@cfp/shared` renderer — same output as before, no transforms.
 *
 * Per specs/behaviors/markdown-rendering.md.
 */
import { renderMarkdown } from '@cfp/shared';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { setRenderMarkdown } from '../services/serializers/common.js';

async function markdownPlugin(fastify: FastifyInstance): Promise<void> {
  const siteHost = fastify.config.CFP_SITE_HOST;
  // Closure over the LIVE inMemoryState reference (not its value) so the
  // resolver always sees the current Map even after hot-reload swaps state
  // in place. (Hot reload preserves `state` identity per
  // specs/behaviors/storage.md#hot-reload — the Maps are mutated in place,
  // not replaced.)
  const state = fastify.inMemoryState;
  setRenderMarkdown((source) =>
    renderMarkdown(source, {
      siteHost,
      resolveMention: (slug) => state.personIdBySlug.has(slug),
    }),
  );
}

export default fp(markdownPlugin, {
  name: 'markdown',
  dependencies: ['services'],
});
