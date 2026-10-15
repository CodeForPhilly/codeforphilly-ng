/**
 * State-apply pattern: queue in-memory state + FTS mutations to fire AFTER
 * the gitsheets transaction commits successfully.
 *
 * Write services build a `StateApply` inside their handler and the route
 * calls `apply()` after `store.transact` resolves. If `store.transact`
 * throws (handler error, parent-moved conflict), the StateApply is never
 * applied — in-memory state stays in sync with the on-disk gitsheets state.
 */
import type {
  BlogPost,
  Event,
  EventRsvp,
  EventSeries,
  HelpWantedInterestExpression,
  HelpWantedRole,
  Person,
  PersonEvaluation,
  Project,
  ProjectBuzz,
  ProjectMembership,
  ProjectUpdate,
  SlugHistory,
  Tag,
  TagAssignment,
} from '@cfp/shared/schemas';
import type { FtsEngine } from './fts.js';
import { invalidateFacets } from './memory/facets.js';
import {
  indexEvent,
  indexEventRsvp,
  indexEventSeries,
  indexHelpWantedInterest,
  indexHelpWantedRole,
  indexMembership,
  indexPerson,
  indexPersonEvaluation,
  indexProject,
  indexProjectBuzz,
  indexProjectUpdate,
  indexSlugHistory,
  indexTag,
  indexTagAssignment,
  unindexEventRsvp,
  unindexEventSeries,
  unindexHelpWantedInterest,
  unindexHelpWantedRole,
  unindexMembership,
  unindexPersonEvaluation,
  unindexProjectBuzz,
  unindexProjectUpdate,
  type InMemoryState,
} from './memory/state.js';

type Op = (state: InMemoryState, fts: FtsEngine) => void;

export class StateApply {
  readonly #ops: Op[] = [];
  #invalidateFacets = false;

  upsertProject(project: Project): this {
    this.#ops.push((state, fts) => {
      indexProject(state, project);
      if (project.deletedAt) {
        fts.removeProject(project.slug);
      } else {
        fts.upsertProject(
          project.slug,
          project.title,
          project.summary ?? '',
          project.overview ?? '',
        );
      }
    });
    this.#invalidateFacets = true;
    return this;
  }

  removeProject(projectId: string, slug: string): this {
    this.#ops.push((state, fts) => {
      const old = state.projects.get(projectId);
      state.projects.delete(projectId);
      state.projectSlugById.delete(projectId);
      state.projectIdBySlug.delete(slug);
      if (old && typeof old.legacyId === 'number') {
        state.projectIdByLegacyId.delete(old.legacyId);
      }
      fts.removeProject(slug);
    });
    this.#invalidateFacets = true;
    return this;
  }

  /**
   * Apply a project slug rename — old slug fully removed from index.
   *
   * `newSlug` is not used here (the new slug index entry is added by the
   * subsequent `upsertProject` call) but is kept in the signature for
   * call-site clarity.
   */
  renameProjectSlug(_projectId: string, oldSlug: string, _newSlug: string): this {
    void _projectId;
    void _newSlug;
    this.#ops.push((state, fts) => {
      state.projectIdBySlug.delete(oldSlug);
      // Remove FTS row for the old slug; the upsert with the new slug
      // happens via upsertProject() in the same StateApply.
      fts.removeProject(oldSlug);
    });
    return this;
  }

  upsertPerson(person: Person): this {
    this.#ops.push((state, fts) => {
      indexPerson(state, person);
      if (person.deletedAt) {
        fts.removePerson(person.slug);
      } else {
        fts.upsertPerson(person.slug, person.fullName, person.bio ?? '');
      }
    });
    this.#invalidateFacets = true;
    return this;
  }

  removePerson(personId: string, slug: string): this {
    this.#ops.push((state, fts) => {
      state.people.delete(personId);
      state.personSlugById.delete(personId);
      state.personIdBySlug.delete(slug);
      fts.removePerson(slug);
    });
    this.#invalidateFacets = true;
    return this;
  }

  renamePersonSlug(_personId: string, oldSlug: string, _newSlug: string): this {
    void _personId;
    void _newSlug;
    this.#ops.push((state, fts) => {
      state.personIdBySlug.delete(oldSlug);
      fts.removePerson(oldSlug);
    });
    return this;
  }

  upsertTag(tag: Tag): this {
    this.#ops.push((state) => {
      indexTag(state, tag);
    });
    this.#invalidateFacets = true;
    return this;
  }

  removeTag(tagId: string, handle: string): this {
    this.#ops.push((state) => {
      state.tags.delete(tagId);
      state.tagIdByHandle.delete(handle);
    });
    this.#invalidateFacets = true;
    return this;
  }

  upsertTagAssignment(ta: TagAssignment): this {
    this.#ops.push((state) => indexTagAssignment(state, ta));
    this.#invalidateFacets = true;
    return this;
  }

  removeTagAssignment(ta: TagAssignment): this {
    this.#ops.push((state) => {
      state.tagAssignments.delete(ta.id);
      state.tagAssignmentsByTaggable.get(ta.taggableId)?.delete(ta.id);
      state.tagAssignmentsByTag.get(ta.tagId)?.delete(ta.id);
    });
    this.#invalidateFacets = true;
    return this;
  }

  upsertMembership(m: ProjectMembership): this {
    this.#ops.push((state) => indexMembership(state, m));
    return this;
  }

  removeMembership(m: ProjectMembership): this {
    this.#ops.push((state) => unindexMembership(state, m));
    return this;
  }

  upsertProjectUpdate(u: ProjectUpdate): this {
    this.#ops.push((state) => indexProjectUpdate(state, u));
    return this;
  }

  removeProjectUpdate(u: ProjectUpdate): this {
    this.#ops.push((state) => unindexProjectUpdate(state, u));
    return this;
  }

  upsertProjectBuzz(b: ProjectBuzz): this {
    this.#ops.push((state) => indexProjectBuzz(state, b));
    return this;
  }

  removeProjectBuzz(b: ProjectBuzz): this {
    this.#ops.push((state) => unindexProjectBuzz(state, b));
    return this;
  }

  upsertHelpWantedRole(r: HelpWantedRole): this {
    this.#ops.push((state, fts) => {
      indexHelpWantedRole(state, r);
      fts.upsertHelpWanted(r.id, r.title, r.description);
    });
    return this;
  }

  removeHelpWantedRole(r: HelpWantedRole): this {
    this.#ops.push((state, fts) => {
      unindexHelpWantedRole(state, r);
      fts.removeHelpWanted(r.id);
    });
    return this;
  }

  upsertInterest(e: HelpWantedInterestExpression): this {
    this.#ops.push((state) => indexHelpWantedInterest(state, e));
    return this;
  }

  removeInterest(e: HelpWantedInterestExpression): this {
    this.#ops.push((state) => unindexHelpWantedInterest(state, e));
    return this;
  }

  upsertBlogPost(post: BlogPost): this {
    this.#ops.push((state) => {
      state.blogPosts.set(post.id, post);
      state.blogPostIdBySlug.set(post.slug, post.id);
      if (typeof post.legacyId === 'number') {
        state.blogPostIdByLegacyId.set(post.legacyId, post.id);
      }
    });
    return this;
  }

  removeBlogPost(post: BlogPost): this {
    this.#ops.push((state) => {
      state.blogPosts.delete(post.id);
      state.blogPostIdBySlug.delete(post.slug);
      if (typeof post.legacyId === 'number') {
        state.blogPostIdByLegacyId.delete(post.legacyId);
      }
    });
    return this;
  }

  /**
   * Mirror a SlugHistory upsert into the in-memory map so the slug-redirect
   * plugin sees it on the very next request. Expiry filtering happens inside
   * indexSlugHistory — already-expired records are no-ops here.
   */
  upsertSlugHistory(record: SlugHistory): this {
    this.#ops.push((state) => indexSlugHistory(state, record));
    return this;
  }

  upsertPersonEvaluation(record: PersonEvaluation): this {
    this.#ops.push((state) => indexPersonEvaluation(state, record));
    return this;
  }

  removePersonEvaluation(record: PersonEvaluation): this {
    this.#ops.push((state) => unindexPersonEvaluation(state, record));
    return this;
  }

  upsertEvent(event: Event): this {
    this.#ops.push((state) => indexEvent(state, event));
    return this;
  }

  removeEvent(event: Event): this {
    this.#ops.push((state) => {
      state.events.delete(event.id);
      state.eventIdBySlug.delete(event.slug);
      if (typeof event.legacyId === 'number') state.eventIdByLegacyId.delete(event.legacyId);
    });
    return this;
  }

  /** Drop the old slug's index entry on rename; `upsertEvent` adds the new one. */
  renameEventSlug(oldSlug: string): this {
    this.#ops.push((state) => {
      state.eventIdBySlug.delete(oldSlug);
    });
    return this;
  }

  upsertEventSeries(series: EventSeries): this {
    this.#ops.push((state) => indexEventSeries(state, series));
    return this;
  }

  removeEventSeries(series: EventSeries): this {
    this.#ops.push((state) => unindexEventSeries(state, series));
    return this;
  }

  /** Drop the old slug's index entry on rename; `upsertEventSeries` adds the new one. */
  renameEventSeriesSlug(oldSlug: string): this {
    this.#ops.push((state) => {
      state.eventSeriesIdBySlug.delete(oldSlug);
    });
    return this;
  }

  upsertEventRsvp(rsvp: EventRsvp): this {
    this.#ops.push((state) => indexEventRsvp(state, rsvp));
    return this;
  }

  removeEventRsvp(rsvp: EventRsvp): this {
    this.#ops.push((state) => unindexEventRsvp(state, rsvp));
    return this;
  }

  apply(state: InMemoryState, fts: FtsEngine): void {
    for (const op of this.#ops) {
      op(state, fts);
    }
    if (this.#invalidateFacets) invalidateFacets();
  }
}
