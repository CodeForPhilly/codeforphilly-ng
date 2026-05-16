/**
 * Project membership writes:
 *  - POST   /api/projects/:slug/members          (maintainer | staff)
 *  - PATCH  /api/projects/:slug/members/:slug    (maintainer | staff)
 *  - DELETE /api/projects/:slug/members/:slug    (maintainer | staff)
 *  - POST   /api/projects/:slug/members/join     (user)
 *  - POST   /api/projects/:slug/members/leave    (user, self)
 */
import { uuidv7 } from 'uuidv7';
import {
  ProjectMembershipSchema,
  type Person,
  type Project,
  type ProjectMembership,
} from '@cfp/shared/schemas';
import type { DualStoreTx } from '../store/store.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import {
  ApiNotFoundError,
  ApiValidationError,
  ConflictError,
} from '../lib/errors.js';
import { requireAuth } from '../auth/require.js';
import type { SessionContext } from '../auth/middleware.js';

function nowIso(): string {
  return new Date().toISOString();
}

function withMembershipPath(
  m: ProjectMembership,
  projectSlug: string,
  personSlug: string,
): Record<string, unknown> {
  return { ...m, projectSlug, personSlug };
}

export class ProjectMembershipWriteService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  async add(
    tx: DualStoreTx,
    projectSlug: string,
    input: { personSlug: string; role?: string | null },
    session: SessionContext,
  ): Promise<{ membership: ProjectMembership; stateApply: StateApply }> {
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    requireAuth('maintainer | staff', { session, project, memberships });

    const { person } = this.#personOrThrow(input.personSlug);
    if (memberships.some((m) => m.personId === person.id)) {
      throw new ConflictError(
        `${person.slug} is already a member of this project`,
        'already_member',
      );
    }
    if (input.role !== undefined && input.role !== null && input.role.length > 80) {
      throw new ApiValidationError('role too long (max 80 chars)', { role: 'too_long' });
    }

    return this.#createMembership(tx, project, person, {
      role: input.role ?? null,
      isMaintainer: false,
    });
  }

  async update(
    tx: DualStoreTx,
    projectSlug: string,
    personSlug: string,
    input: { role?: string | null },
    session: SessionContext,
  ): Promise<{ membership: ProjectMembership; stateApply: StateApply }> {
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    requireAuth('maintainer | staff', { session, project, memberships });

    const { person } = this.#personOrThrow(personSlug);
    const membership = memberships.find((m) => m.personId === person.id);
    if (!membership) {
      throw new ApiNotFoundError(`${person.slug} is not a member of this project`);
    }

    if (input.role !== undefined && input.role !== null && input.role.length > 80) {
      throw new ApiValidationError('role too long (max 80 chars)', { role: 'too_long' });
    }

    const updated: ProjectMembership = ProjectMembershipSchema.parse({
      ...membership,
      role: input.role === undefined ? membership.role : input.role,
      updatedAt: nowIso(),
    });

    await tx.public['project-memberships'].upsert(
      withMembershipPath(updated, project.slug, person.slug) as unknown as ProjectMembership,
    );

    const stateApply = new StateApply().upsertMembership(updated);
    return { membership: updated, stateApply };
  }

  async remove(
    tx: DualStoreTx,
    projectSlug: string,
    personSlug: string,
    session: SessionContext,
  ): Promise<{ stateApply: StateApply }> {
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    requireAuth('maintainer | staff', { session, project, memberships });

    const { person } = this.#personOrThrow(personSlug);
    const membership = memberships.find((m) => m.personId === person.id);
    if (!membership) {
      throw new ApiNotFoundError(`${person.slug} is not a member of this project`);
    }
    if (project.maintainerId === person.id) {
      throw new ConflictError(
        'Cannot remove the current maintainer; transfer first',
        'cannot_remove_maintainer',
      );
    }

    await tx.public['project-memberships'].delete(
      withMembershipPath(membership, project.slug, person.slug) as unknown as ProjectMembership,
    );

    const stateApply = new StateApply().removeMembership(membership);
    return { stateApply };
  }

  async join(
    tx: DualStoreTx,
    projectSlug: string,
    session: SessionContext,
  ): Promise<{ membership: ProjectMembership; stateApply: StateApply }> {
    requireAuth('user', { session });
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    const person = session.person!;

    if (memberships.some((m) => m.personId === person.id)) {
      throw new ConflictError('Already a member of this project', 'already_member');
    }

    return this.#createMembership(tx, project, person, { role: null, isMaintainer: false });
  }

  async leave(
    tx: DualStoreTx,
    projectSlug: string,
    session: SessionContext,
  ): Promise<{ stateApply: StateApply }> {
    requireAuth('user', { session });
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    const person = session.person!;

    const membership = memberships.find((m) => m.personId === person.id);
    if (!membership) {
      throw new ApiNotFoundError(`You are not a member of this project`);
    }
    if (project.maintainerId === person.id) {
      throw new ConflictError(
        'Cannot leave as the current maintainer; transfer first',
        'cannot_remove_maintainer',
      );
    }

    await tx.public['project-memberships'].delete(
      withMembershipPath(membership, project.slug, person.slug) as unknown as ProjectMembership,
    );

    const stateApply = new StateApply().removeMembership(membership);
    return { stateApply };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  async #createMembership(
    tx: DualStoreTx,
    project: Project,
    person: Person,
    opts: { role: string | null; isMaintainer: boolean },
  ): Promise<{ membership: ProjectMembership; stateApply: StateApply }> {
    const now = nowIso();
    const membership: ProjectMembership = ProjectMembershipSchema.parse({
      id: uuidv7(),
      projectId: project.id,
      personId: person.id,
      role: opts.role,
      isMaintainer: opts.isMaintainer,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await tx.public['project-memberships'].upsert(
      withMembershipPath(membership, project.slug, person.slug) as unknown as ProjectMembership,
    );

    const stateApply = new StateApply().upsertMembership(membership);
    return { membership, stateApply };
  }

  #projectOrThrow(slug: string): { project: Project; memberships: ProjectMembership[] } {
    const id = this.#state.projectIdBySlug.get(slug);
    if (!id) throw new ApiNotFoundError(`Project '${slug}' not found`);
    const p = this.#state.projects.get(id);
    if (!p || p.deletedAt) throw new ApiNotFoundError(`Project '${slug}' not found`);

    const mIds = this.#state.membershipsByProject.get(id) ?? new Set();
    const memberships = [...mIds]
      .map((mId) => this.#state.projectMemberships.get(mId))
      .filter((m): m is ProjectMembership => m !== undefined);
    return { project: p, memberships };
  }

  #personOrThrow(slug: string): { person: Person } {
    const id = this.#state.personIdBySlug.get(slug);
    if (!id) throw new ApiNotFoundError(`Person '${slug}' not found`);
    const p = this.#state.people.get(id);
    if (!p || p.deletedAt) throw new ApiNotFoundError(`Person '${slug}' not found`);
    return { person: p };
  }
}
