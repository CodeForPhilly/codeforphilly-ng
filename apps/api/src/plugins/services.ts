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
import { buildFtsEngine, type FtsEngine } from '../store/fts.js';
import type { InMemoryState } from '../store/memory/state.js';
import { ProjectService } from '../services/project.js';
import { PersonService } from '../services/person.js';
import { TagService } from '../services/tag.js';
import { ProjectUpdateService } from '../services/project-update.js';
import { ProjectBuzzService } from '../services/project-buzz.js';
import { HelpWantedService } from '../services/help-wanted.js';
import { ProjectWriteService } from '../services/project.write.js';
import { ProjectMembershipWriteService } from '../services/project-membership.write.js';
import { ProjectUpdateWriteService } from '../services/project-update.write.js';
import { ProjectBuzzWriteService } from '../services/project-buzz.write.js';
import { HelpWantedWriteService } from '../services/help-wanted.write.js';
import { PersonWriteService } from '../services/person.write.js';
import { TagWriteService } from '../services/tag.write.js';
import { LoggingNotifier, type Notifier } from '../notify/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    services: {
      projects: ProjectService;
      people: PersonService;
      tags: TagService;
      projectUpdates: ProjectUpdateService;
      projectBuzz: ProjectBuzzService;
      helpWanted: HelpWantedService;
      // Write services
      projectsWrite: ProjectWriteService;
      projectMembershipsWrite: ProjectMembershipWriteService;
      projectUpdatesWrite: ProjectUpdateWriteService;
      projectBuzzWrite: ProjectBuzzWriteService;
      helpWantedWrite: HelpWantedWriteService;
      peopleWrite: PersonWriteService;
      tagsWrite: TagWriteService;
    };
    /** Shared in-memory state — write routes call StateApply.apply against this. */
    inMemoryState: InMemoryState;
    fts: FtsEngine;
    notifier: Notifier;
  }
}

async function servicesPlugin(fastify: FastifyInstance): Promise<void> {
  const publicStore = fastify.store.public;
  const state = await loadInMemoryState(publicStore);
  // Reset module-level facet cache so a fresh boot reflects current state
  // (relevant in tests where multiple buildApp() runs share the module).
  invalidateFacets();
  const fts = buildFtsEngine(state);
  const notifier: Notifier = new LoggingNotifier(fastify.log);

  fastify.decorate('inMemoryState', state);
  fastify.decorate('fts', fts);
  fastify.decorate('notifier', notifier);

  fastify.decorate('services', {
    projects: new ProjectService(state, fts),
    people: new PersonService(state, fts),
    tags: new TagService(state),
    projectUpdates: new ProjectUpdateService(state),
    projectBuzz: new ProjectBuzzService(state),
    helpWanted: new HelpWantedService(state, fts),
    projectsWrite: new ProjectWriteService(state),
    projectMembershipsWrite: new ProjectMembershipWriteService(state),
    projectUpdatesWrite: new ProjectUpdateWriteService(state),
    projectBuzzWrite: new ProjectBuzzWriteService(state),
    helpWantedWrite: new HelpWantedWriteService(state),
    peopleWrite: new PersonWriteService(state, fastify.store.private),
    tagsWrite: new TagWriteService(state),
  });
}

export default fp(servicesPlugin, {
  name: 'services',
  fastify: '5.x',
  dependencies: ['store'],
});
