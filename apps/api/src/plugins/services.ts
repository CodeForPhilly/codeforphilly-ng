/**
 * Services plugin.
 *
 * Loads in-memory state from the public store, builds the FTS engine,
 * and decorates fastify with service instances that route handlers use.
 *
 * Depends on the store plugin (for fastify.store).
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { loadInMemoryState } from '../store/memory/loader.js';
import { invalidateFacets } from '../store/memory/facets.js';
import { buildFtsEngine } from '../store/fts.js';
import { ProjectService } from '../services/project.js';
import { PersonService } from '../services/person.js';
import { TagService } from '../services/tag.js';
import { ProjectUpdateService } from '../services/project-update.js';
import { ProjectBuzzService } from '../services/project-buzz.js';
import { HelpWantedService } from '../services/help-wanted.js';

declare module 'fastify' {
  interface FastifyInstance {
    services: {
      projects: ProjectService;
      people: PersonService;
      tags: TagService;
      projectUpdates: ProjectUpdateService;
      projectBuzz: ProjectBuzzService;
      helpWanted: HelpWantedService;
    };
  }
}

async function servicesPlugin(fastify: FastifyInstance): Promise<void> {
  const publicStore = fastify.store.public;
  const state = await loadInMemoryState(publicStore);
  // Reset module-level facet cache so a fresh boot reflects current state
  // (relevant in tests where multiple buildApp() runs share the module).
  invalidateFacets();
  const fts = buildFtsEngine(state);

  fastify.decorate('services', {
    projects: new ProjectService(state, fts),
    people: new PersonService(state, fts),
    tags: new TagService(state),
    projectUpdates: new ProjectUpdateService(state),
    projectBuzz: new ProjectBuzzService(state),
    helpWanted: new HelpWantedService(state, fts),
  });
}

export default fp(servicesPlugin, {
  name: 'services',
  fastify: '5.x',
  dependencies: ['store'],
});
