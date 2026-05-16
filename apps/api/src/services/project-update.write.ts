/**
 * Project update writes:
 *  - POST   /api/projects/:slug/updates              (member | staff)
 *  - PATCH  /api/projects/:slug/updates/:number      (author | staff)
 *  - DELETE /api/projects/:slug/updates/:number      (author | staff)
 */
import { uuidv7 } from 'uuidv7';
import {
  ProjectUpdateSchema,
  type Project,
  type ProjectMembership,
  type ProjectUpdate,
} from '@cfp/shared/schemas';
import type { DualStoreTx } from '../store/store.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { requireAuth } from '../auth/require.js';
import type { SessionContext } from '../auth/middleware.js';

const MAX_BODY = 20_000;

function nowIso(): string {
  return new Date().toISOString();
}

function withProjectPath<T extends object>(record: T, projectSlug: string): Record<string, unknown> {
  return { ...record, projectSlug };
}

export class ProjectUpdateWriteService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  async create(
    tx: DualStoreTx,
    projectSlug: string,
    input: { body: string },
    session: SessionContext,
  ): Promise<{ update: ProjectUpdate; stateApply: StateApply }> {
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    requireAuth('member | staff', { session, project, memberships });

    if (!input.body || input.body.length === 0 || input.body.length > MAX_BODY) {
      throw new ApiValidationError(`body required, 1-${MAX_BODY} chars`, { body: 'required' });
    }

    // Next number for this project
    const existing = this.#state.updatesByProject.get(project.id) ?? new Set();
    let maxNumber = 0;
    for (const id of existing) {
      const u = this.#state.projectUpdates.get(id);
      if (u && u.number > maxNumber) maxNumber = u.number;
    }
    const number = maxNumber + 1;

    const now = nowIso();
    const update: ProjectUpdate = ProjectUpdateSchema.parse({
      id: uuidv7(),
      projectId: project.id,
      authorId: session.person!.id,
      body: input.body,
      number,
      createdAt: now,
      updatedAt: now,
    });

    await tx.public['project-updates'].upsert(
      withProjectPath(update, project.slug) as unknown as ProjectUpdate,
    );

    const stateApply = new StateApply().upsertProjectUpdate(update);
    return { update, stateApply };
  }

  async update(
    tx: DualStoreTx,
    projectSlug: string,
    number: number,
    input: { body: string },
    session: SessionContext,
  ): Promise<{ update: ProjectUpdate; stateApply: StateApply }> {
    const { project } = this.#projectOrThrow(projectSlug);
    const existing = this.#updateOrThrow(project, number);

    requireAuth('author | staff', { session, ownerId: existing.authorId ?? undefined });

    if (!input.body || input.body.length === 0 || input.body.length > MAX_BODY) {
      throw new ApiValidationError(`body required, 1-${MAX_BODY} chars`, { body: 'required' });
    }

    const updated: ProjectUpdate = ProjectUpdateSchema.parse({
      ...existing,
      body: input.body,
      updatedAt: nowIso(),
    });

    await tx.public['project-updates'].upsert(
      withProjectPath(updated, project.slug) as unknown as ProjectUpdate,
    );

    const stateApply = new StateApply().upsertProjectUpdate(updated);
    return { update: updated, stateApply };
  }

  async delete(
    tx: DualStoreTx,
    projectSlug: string,
    number: number,
    session: SessionContext,
  ): Promise<{ stateApply: StateApply }> {
    const { project } = this.#projectOrThrow(projectSlug);
    const existing = this.#updateOrThrow(project, number);

    requireAuth('author | staff', { session, ownerId: existing.authorId ?? undefined });

    await tx.public['project-updates'].delete(
      withProjectPath(existing, project.slug) as unknown as ProjectUpdate,
    );

    const stateApply = new StateApply().removeProjectUpdate(existing);
    return { stateApply };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

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

  #updateOrThrow(project: Project, number: number): ProjectUpdate {
    const id = this.#state.updateByProjectAndNumber.get(`${project.id}:${number}`);
    if (!id) throw new ApiNotFoundError(`Update #${number} not found on project '${project.slug}'`);
    const u = this.#state.projectUpdates.get(id);
    if (!u) throw new ApiNotFoundError(`Update #${number} not found on project '${project.slug}'`);
    return u;
  }
}
