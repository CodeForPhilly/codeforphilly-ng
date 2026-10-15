/**
 * The projects a person purge takes with it — specs/behaviors/person-lifecycle.md
 * → Purge: projects the person created (`createdById`, or `maintainerId` when
 * a project has no `createdById`) that nobody else touched, deleted with
 * everything that hangs off them.
 */
import type { Person, Project } from '@cfp/shared/schemas';

import type { InMemoryState } from '../store/memory/state.js';
import type { StateApply } from '../store/state-apply.js';
import type { DualStoreTx } from '../store/store.js';

function idsIn(index: Map<string, Set<string>>, key: string): string[] {
  return [...(index.get(key) ?? [])];
}

/** Whether `person` created `project` — the field, else the maintainer for older records. */
function createdBy(project: Project, person: Person): boolean {
  return project.createdById ? project.createdById === person.id : project.maintainerId === person.id;
}

/** Whether anyone but `person` has a record on `project`. */
function touchedByOthers(state: InMemoryState, project: Project, person: Person): boolean {
  for (const id of idsIn(state.membershipsByProject, project.slug)) {
    if (state.projectMemberships.get(id)?.personSlug !== person.slug) return true;
  }
  for (const id of idsIn(state.updatesByProject, project.slug)) {
    if (state.projectUpdates.get(id)?.authorId !== person.id) return true;
  }
  for (const id of idsIn(state.buzzByProject, project.slug)) {
    if (state.projectBuzz.get(id)?.postedById !== person.id) return true;
  }
  for (const roleId of idsIn(state.helpWantedByProject, project.slug)) {
    if (state.helpWantedRoles.get(roleId)?.postedById !== person.id) return true;
    for (const id of idsIn(state.interestByRole, roleId)) {
      if (state.helpWantedInterest.get(id)?.personSlug !== person.slug) return true;
    }
  }
  for (const rsvp of state.eventRsvps.values()) {
    if (rsvp.projectId === project.id && rsvp.personSlug !== person.slug) return true;
  }
  return false;
}

/** Live or soft-deleted projects a purge of `person` deletes, by title. */
export function purgeableProjects(state: InMemoryState, person: Person): Project[] {
  return [...state.projects.values()]
    .filter((p) => createdBy(p, person) && !touchedByOthers(state, p, person))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Hard-delete `project` and every record on it inside `tx`. Records already
 * deleted earlier in the same transaction (ids in `deleted`) are skipped, and
 * every id this deletes is added, so the person cascade can skip them too.
 */
export async function purgeProject(
  tx: DualStoreTx,
  state: InMemoryState,
  stateApply: StateApply,
  project: Project,
  deleted: Set<string>,
): Promise<void> {
  const once = async (id: string, del: () => Promise<void>) => {
    if (deleted.has(id)) return;
    deleted.add(id);
    await del();
  };

  for (const id of idsIn(state.membershipsByProject, project.slug)) {
    const m = state.projectMemberships.get(id);
    if (m) await once(m.id, async () => { await tx.public['project-memberships'].delete(m); stateApply.removeMembership(m); });
  }
  for (const id of idsIn(state.updatesByProject, project.slug)) {
    const u = state.projectUpdates.get(id);
    if (u) await once(u.id, async () => { await tx.public['project-updates'].delete(u); stateApply.removeProjectUpdate(u); });
  }
  for (const id of idsIn(state.buzzByProject, project.slug)) {
    const b = state.projectBuzz.get(id);
    if (b) await once(b.id, async () => { await tx.public['project-buzz'].delete(b); stateApply.removeProjectBuzz(b); });
  }
  for (const roleId of idsIn(state.helpWantedByProject, project.slug)) {
    for (const id of idsIn(state.interestByRole, roleId)) {
      const e = state.helpWantedInterest.get(id);
      if (e) await once(e.id, async () => { await tx.public['help-wanted-interest'].delete(e); stateApply.removeInterest(e); });
    }
    await deleteTagAssignments(tx, state, stateApply, roleId, once);
    const r = state.helpWantedRoles.get(roleId);
    if (r) await once(r.id, async () => { await tx.public['help-wanted-roles'].delete(r); stateApply.removeHelpWantedRole(r); });
  }
  for (const rsvp of [...state.eventRsvps.values()]) {
    if (rsvp.projectId !== project.id) continue;
    await once(rsvp.id, async () => { await tx.public['event-rsvps'].delete(rsvp); stateApply.removeEventRsvp(rsvp); });
  }
  await deleteTagAssignments(tx, state, stateApply, project.id, once);
  // Deleting the record removes its attachment folder with it.
  await once(project.id, async () => {
    await tx.public.projects.delete(project);
    stateApply.removeProject(project.id, project.slug);
  });
}

async function deleteTagAssignments(
  tx: DualStoreTx,
  state: InMemoryState,
  stateApply: StateApply,
  taggableId: string,
  once: (id: string, del: () => Promise<void>) => Promise<void>,
): Promise<void> {
  for (const id of idsIn(state.tagAssignmentsByTaggable, taggableId)) {
    const ta = state.tagAssignments.get(id);
    if (ta) await once(ta.id, async () => { await tx.public['tag-assignments'].delete(ta); stateApply.removeTagAssignment(ta); });
  }
}
