/**
 * Loads all gitsheets records into the InMemoryState at boot.
 *
 * Reads directly from the store's top-level sheet properties (no transaction
 * needed for reads). Builds all secondary indices.
 */
import type { PublicStore } from '../public.js';
import {
  createEmptyState,
  indexHelpWantedInterest,
  indexHelpWantedRole,
  indexMembership,
  indexPerson,
  indexProject,
  indexProjectBuzz,
  indexProjectUpdate,
  indexTag,
  indexTagAssignment,
  type InMemoryState,
} from './state.js';

export async function loadInMemoryState(publicStore: PublicStore): Promise<InMemoryState> {
  const state = createEmptyState();

  const [
    projects,
    people,
    tags,
    tagAssignments,
    memberships,
    updates,
    buzzes,
    roles,
    interests,
  ] = await Promise.all([
    publicStore.projects.queryAll(),
    publicStore.people.queryAll(),
    publicStore.tags.queryAll(),
    publicStore['tag-assignments'].queryAll(),
    publicStore['project-memberships'].queryAll(),
    publicStore['project-updates'].queryAll(),
    publicStore['project-buzz'].queryAll(),
    publicStore['help-wanted-roles'].queryAll(),
    publicStore['help-wanted-interest'].queryAll(),
  ]);

  for (const p of projects) indexProject(state, p);
  for (const p of people) indexPerson(state, p);
  for (const t of tags) indexTag(state, t);
  for (const ta of tagAssignments) indexTagAssignment(state, ta);
  for (const m of memberships) indexMembership(state, m);
  for (const u of updates) indexProjectUpdate(state, u);
  for (const b of buzzes) indexProjectBuzz(state, b);
  for (const r of roles) indexHelpWantedRole(state, r);
  for (const i of interests) indexHelpWantedInterest(state, i);

  return state;
}
