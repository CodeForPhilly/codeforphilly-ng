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
  HelpWantedInterestExpression,
  HelpWantedRole,
  Person,
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
  indexHelpWantedInterest,
  indexHelpWantedRole,
  indexMembership,
  indexPerson,
  indexProject,
  indexProjectBuzz,
  indexProjectUpdate,
  indexSlugHistory,
  indexTag,
  indexTagAssignment,
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
      state.projects.delete(projectId);
      state.projectSlugById.delete(projectId);
      state.projectIdBySlug.delete(slug);
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
    this.#ops.push((state) => {
      state.projectMemberships.delete(m.id);
      state.membershipsByProject.get(m.projectId)?.delete(m.id);
      state.membershipsByPerson.get(m.personId)?.delete(m.id);
    });
    return this;
  }

  upsertProjectUpdate(u: ProjectUpdate): this {
    this.#ops.push((state) => indexProjectUpdate(state, u));
    return this;
  }

  removeProjectUpdate(u: ProjectUpdate): this {
    this.#ops.push((state) => {
      state.projectUpdates.delete(u.id);
      state.updatesByProject.get(u.projectId)?.delete(u.id);
      state.updateByProjectAndNumber.delete(`${u.projectId}:${u.number}`);
    });
    return this;
  }

  upsertProjectBuzz(b: ProjectBuzz): this {
    this.#ops.push((state) => indexProjectBuzz(state, b));
    return this;
  }

  removeProjectBuzz(b: ProjectBuzz): this {
    this.#ops.push((state) => {
      state.projectBuzz.delete(b.id);
      state.buzzByProject.get(b.projectId)?.delete(b.id);
      state.buzzByProjectAndSlug.delete(`${b.projectId}:${b.slug}`);
    });
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
      state.helpWantedRoles.delete(r.id);
      state.helpWantedByProject.get(r.projectId)?.delete(r.id);
      fts.removeHelpWanted(r.id);
    });
    return this;
  }

  upsertInterest(e: HelpWantedInterestExpression): this {
    this.#ops.push((state) => indexHelpWantedInterest(state, e));
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

  apply(state: InMemoryState, fts: FtsEngine): void {
    for (const op of this.#ops) {
      op(state, fts);
    }
    if (this.#invalidateFacets) invalidateFacets();
  }
}
