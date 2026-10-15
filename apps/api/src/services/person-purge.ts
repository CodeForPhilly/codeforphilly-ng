/**
 * Purge — the cascading hard delete behind the admin Purge button and the
 * scheduled spam purge (specs/behaviors/person-lifecycle.md). Everything
 * happens inside the caller's transaction, so a batch is one commit.
 */
import type { Person } from '@cfp/shared/schemas';

import type { InMemoryState } from '../store/memory/state.js';
import type { StateApply } from '../store/state-apply.js';
import type { DualStoreTx } from '../store/store.js';
import { purgeableProjects, purgeProject } from './project-purge.js';

/**
 * Hard-delete `people` and everything that is theirs: first the projects only
 * they touched (judged across the whole batch, before anything is deleted),
 * then each person's own records. Ids deleted along the way are tracked so no
 * record is deleted twice.
 */
export async function purgePeople(
  tx: DualStoreTx,
  state: InMemoryState,
  stateApply: StateApply,
  people: readonly Person[],
): Promise<void> {
  const deleted = new Set<string>();
  for (const project of purgeableProjects(state, people)) {
    await purgeProject(tx, state, stateApply, project, deleted);
  }
  for (const person of people) {
    await purgePersonRecords(tx, state, stateApply, person, deleted);
  }
}

async function purgePersonRecords(
  tx: DualStoreTx,
  state: InMemoryState,
  stateApply: StateApply,
  existing: Person,
  deleted: Set<string>,
): Promise<void> {
  const personId = existing.id;

  // 1. Delete the person record.
  await tx.public.people.delete(existing);
  stateApply.removePerson(personId, existing.slug);
  // Their private data goes in the same transaction (profile, legacy password,
  // reset tokens, claim requests).
  tx.private.deletePersonData(personId);

  // 2. Cascade-delete project-memberships.
  const membershipIds = state.membershipsByPerson.get(existing.slug) ?? new Set<string>();
  for (const mId of membershipIds) {
    const m = state.projectMemberships.get(mId);
    if (m && !deleted.has(m.id)) {
      await tx.public['project-memberships'].delete(m);
      stateApply.removeMembership(m);
    }
  }

  // 3. Cascade-delete help-wanted-interest.
  for (const interest of state.helpWantedInterest.values()) {
    if (interest.personSlug === existing.slug && !deleted.has(interest.id)) {
      await tx.public['help-wanted-interest'].delete(interest);
      stateApply.removeInterest(interest);
    }
  }

  // 3b. Cascade-delete event RSVPs (path: year/eventSlug/personSlug).
  for (const rsvpId of state.rsvpsByPerson.get(existing.slug) ?? new Set<string>()) {
    const rsvp = state.eventRsvps.get(rsvpId);
    if (rsvp && !deleted.has(rsvp.id)) {
      await tx.public['event-rsvps'].delete(rsvp);
      stateApply.removeEventRsvp(rsvp);
    }
  }

  // 4. Cascade-delete person tag-assignments.
  const taIds = state.tagAssignmentsByTaggable.get(personId) ?? new Set<string>();
  for (const taId of taIds) {
    const ta = state.tagAssignments.get(taId);
    if (ta && ta.taggableType === 'person') {
      await tx.public['tag-assignments'].delete(ta);
      stateApply.removeTagAssignment(ta);
    }
  }

  // 5. Delete authored project-updates.
  for (const update of state.projectUpdates.values()) {
    if (update.authorId === personId && !deleted.has(update.id)) {
      await tx.public['project-updates'].delete(update);
      stateApply.removeProjectUpdate(update);
    }
  }

  // 6. Delete posted project-buzz.
  for (const buzz of state.projectBuzz.values()) {
    if (buzz.postedById === personId && !deleted.has(buzz.id)) {
      await tx.public['project-buzz'].delete(buzz);
      stateApply.removeProjectBuzz(buzz);
    }
  }

  // 7. Delete authored blog-posts.
  for (const post of state.blogPosts.values()) {
    if (post.authorId === personId) {
      await tx.public['blog-posts'].delete(post);
      stateApply.removeBlogPost(post);
    }
  }

}
