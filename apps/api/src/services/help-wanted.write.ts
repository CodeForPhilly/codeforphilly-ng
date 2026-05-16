/**
 * Help-wanted role writes:
 *  - POST   /api/projects/:slug/help-wanted                          (maintainer | staff)
 *  - PATCH  /api/projects/:slug/help-wanted/:roleId                  (poster | maintainer | staff)
 *  - POST   /api/projects/:slug/help-wanted/:roleId/express-interest (user, rate-cap)
 *  - POST   /api/projects/:slug/help-wanted/:roleId/fill             (maintainer | staff)
 *  - POST   /api/projects/:slug/help-wanted/:roleId/close            (maintainer | staff)
 *  - POST   /api/projects/:slug/help-wanted/:roleId/reopen           (maintainer | staff)
 *
 * Side effects per specs/behaviors/help-wanted-roles.md:
 *  - fill with attribution → adds the person as a project member if not yet
 *    (Notifier is invoked by the route after commit.)
 *  - express-interest → 30-day rate cap per (roleId, personId); notification
 *    fan-out happens after commit
 */
import { uuidv7 } from 'uuidv7';
import {
  HelpWantedInterestExpressionSchema,
  HelpWantedRoleSchema,
  ProjectMembershipSchema,
  type HelpWantedInterestExpression,
  type HelpWantedRole,
  type Person,
  type Project,
  type ProjectMembership,
} from '@cfp/shared/schemas';
import type { DualStoreTx } from '../store/store.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import { ApiNotFoundError, ApiValidationError, ConflictError } from '../lib/errors.js';
import { requireAuth } from '../auth/require.js';
import type { SessionContext } from '../auth/middleware.js';
import { applyTagsForEntity, type TagAssignmentInput, type TagNamespace } from './tag.write.js';

const MAX_DESCRIPTION = 4_000;
const INTEREST_RATE_CAP_MS = 30 * 24 * 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function withProjectPath<T extends object>(record: T, projectSlug: string): Record<string, unknown> {
  return { ...record, projectSlug };
}

function withInterestPath(
  e: HelpWantedInterestExpression,
  personSlug: string,
): Record<string, unknown> {
  return { ...e, personSlug };
}

function withMembershipPath(
  m: ProjectMembership,
  projectSlug: string,
  personSlug: string,
): Record<string, unknown> {
  return { ...m, projectSlug, personSlug };
}

export class HelpWantedWriteService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  async create(
    tx: DualStoreTx,
    projectSlug: string,
    input: {
      title: string;
      description: string;
      commitmentHoursPerWeek?: number | null;
      tags?: { topic?: string[]; tech?: string[]; event?: string[] };
    },
    session: SessionContext,
  ): Promise<{ role: HelpWantedRole; stateApply: StateApply }> {
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    requireAuth('maintainer | staff', { session, project, memberships });

    if (!input.title || input.title.length < 1 || input.title.length > 120) {
      throw new ApiValidationError('title required, 1-120 chars', { title: 'required' });
    }
    if (
      !input.description ||
      input.description.length < 1 ||
      input.description.length > MAX_DESCRIPTION
    ) {
      throw new ApiValidationError(`description required, 1-${MAX_DESCRIPTION} chars`, {
        description: 'required',
      });
    }
    if (
      input.commitmentHoursPerWeek !== undefined &&
      input.commitmentHoursPerWeek !== null &&
      (input.commitmentHoursPerWeek < 0 || !Number.isInteger(input.commitmentHoursPerWeek))
    ) {
      throw new ApiValidationError('commitmentHoursPerWeek must be a non-negative integer', {
        commitmentHoursPerWeek: 'invalid',
      });
    }

    const now = nowIso();
    const role: HelpWantedRole = HelpWantedRoleSchema.parse({
      id: uuidv7(),
      projectId: project.id,
      postedById: session.person!.id,
      title: input.title,
      description: input.description,
      commitmentHoursPerWeek: input.commitmentHoursPerWeek ?? null,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });

    await tx.public['help-wanted-roles'].upsert(
      withProjectPath(role, project.slug) as unknown as HelpWantedRole,
    );

    const stateApply = new StateApply().upsertHelpWantedRole(role);

    if (input.tags) {
      await applyTagsForEntity(tx, {
        taggableType: 'help_wanted_role',
        taggableId: role.id,
        assignedById: session.person!.id,
        state: this.#state,
        requested: this.#buildTagInputs(input.tags),
        existing: [],
        session,
        stateApply,
      });
    }

    return { role, stateApply };
  }

  async update(
    tx: DualStoreTx,
    projectSlug: string,
    roleId: string,
    input: {
      title?: string;
      description?: string;
      commitmentHoursPerWeek?: number | null;
      tags?: { topic?: string[]; tech?: string[]; event?: string[] };
    },
    session: SessionContext,
  ): Promise<{ role: HelpWantedRole; stateApply: StateApply }> {
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    const existing = this.#roleOrThrow(project.id, roleId);

    // Poster, project maintainer, or staff can edit. Use a two-step check:
    // first try maintainer | staff, fall back to a per-poster check.
    if (session.person?.id !== existing.postedById) {
      requireAuth('maintainer | staff', { session, project, memberships });
    } else {
      requireAuth('user', { session });
    }

    if (input.title !== undefined && (input.title.length < 1 || input.title.length > 120)) {
      throw new ApiValidationError('title 1-120 chars', { title: 'invalid' });
    }
    if (
      input.description !== undefined &&
      (input.description.length < 1 || input.description.length > MAX_DESCRIPTION)
    ) {
      throw new ApiValidationError(`description 1-${MAX_DESCRIPTION} chars`, {
        description: 'invalid',
      });
    }

    const updated: HelpWantedRole = HelpWantedRoleSchema.parse({
      ...existing,
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
      commitmentHoursPerWeek:
        input.commitmentHoursPerWeek === undefined
          ? (existing.commitmentHoursPerWeek ?? null)
          : input.commitmentHoursPerWeek,
      updatedAt: nowIso(),
    });

    await tx.public['help-wanted-roles'].upsert(
      withProjectPath(updated, project.slug) as unknown as HelpWantedRole,
    );

    const stateApply = new StateApply().upsertHelpWantedRole(updated);

    if (input.tags) {
      const existingTas = [...(this.#state.tagAssignmentsByTaggable.get(existing.id) ?? [])]
        .map((taId) => this.#state.tagAssignments.get(taId))
        .filter((ta): ta is NonNullable<typeof ta> => ta?.taggableType === 'help_wanted_role');
      await applyTagsForEntity(tx, {
        taggableType: 'help_wanted_role',
        taggableId: existing.id,
        assignedById: session.person?.id ?? null,
        state: this.#state,
        requested: this.#buildTagInputs(input.tags),
        existing: existingTas,
        replaceNamespaces: Object.keys(input.tags) as Array<TagNamespace>,
        session,
        stateApply,
      });
    }

    return { role: updated, stateApply };
  }

  async expressInterest(
    tx: DualStoreTx,
    projectSlug: string,
    roleId: string,
    input: { message?: string | null },
    session: SessionContext,
  ): Promise<{
    role: HelpWantedRole;
    project: Project;
    poster: Person | null;
    expression: HelpWantedInterestExpression;
    stateApply: StateApply;
  }> {
    requireAuth('user', { session });
    const { project } = this.#projectOrThrow(projectSlug);
    const role = this.#roleOrThrow(project.id, roleId);

    if (role.status !== 'open') {
      throw new ConflictError('Role is not open', 'role_not_open');
    }

    // 30-day rate cap per (roleId, personId)
    const existingId = this.#state.interestByRoleAndPerson.get(`${role.id}:${session.person!.id}`);
    if (existingId) {
      const existing = this.#state.helpWantedInterest.get(existingId);
      if (existing) {
        const elapsed = Date.now() - new Date(existing.createdAt).getTime();
        if (elapsed < INTEREST_RATE_CAP_MS) {
          throw new ConflictError(
            'You already expressed interest in this role recently',
            'already_expressed',
          );
        }
      }
    }

    if (input.message !== undefined && input.message !== null && input.message.length > 2_000) {
      throw new ApiValidationError('message <= 2000 chars', { message: 'too_long' });
    }

    const now = nowIso();
    const expression: HelpWantedInterestExpression = HelpWantedInterestExpressionSchema.parse({
      id: uuidv7(),
      roleId: role.id,
      personId: session.person!.id,
      message: input.message ?? null,
      createdAt: now,
    });

    await tx.public['help-wanted-interest'].upsert(
      withInterestPath(expression, session.person!.slug) as unknown as HelpWantedInterestExpression,
    );

    const stateApply = new StateApply().upsertInterest(expression);
    const poster = this.#state.people.get(role.postedById) ?? null;

    return { role, project, poster, expression, stateApply };
  }

  async fill(
    tx: DualStoreTx,
    projectSlug: string,
    roleId: string,
    input: { filledBySlug?: string | null },
    session: SessionContext,
  ): Promise<{
    role: HelpWantedRole;
    project: Project;
    filledBy: Person | null;
    poster: Person | null;
    stateApply: StateApply;
  }> {
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    const role = this.#roleOrThrow(project.id, roleId);
    requireAuth('maintainer | staff', { session, project, memberships });

    let filledBy: Person | null = null;
    if (input.filledBySlug) {
      const personId = this.#state.personIdBySlug.get(input.filledBySlug);
      if (!personId) {
        throw new ApiNotFoundError(`Person '${input.filledBySlug}' not found`);
      }
      filledBy = this.#state.people.get(personId) ?? null;
      if (!filledBy) throw new ApiNotFoundError(`Person '${input.filledBySlug}' not found`);
    }

    const now = nowIso();
    const updated: HelpWantedRole = HelpWantedRoleSchema.parse({
      ...role,
      status: 'filled',
      filledAt: now,
      filledById: filledBy?.id ?? null,
      closedAt: null,
      updatedAt: now,
    });

    await tx.public['help-wanted-roles'].upsert(
      withProjectPath(updated, project.slug) as unknown as HelpWantedRole,
    );

    const stateApply = new StateApply().upsertHelpWantedRole(updated);

    // Membership side-effect
    if (filledBy && !memberships.some((m) => m.personId === filledBy!.id)) {
      const membership: ProjectMembership = ProjectMembershipSchema.parse({
        id: uuidv7(),
        projectId: project.id,
        personId: filledBy.id,
        role: `Help-wanted: ${role.title}`,
        isMaintainer: false,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.public['project-memberships'].upsert(
        withMembershipPath(membership, project.slug, filledBy.slug) as unknown as ProjectMembership,
      );
      stateApply.upsertMembership(membership);
    }

    const poster = this.#state.people.get(role.postedById) ?? null;
    return { role: updated, project, filledBy, poster, stateApply };
  }

  async close(
    tx: DualStoreTx,
    projectSlug: string,
    roleId: string,
    session: SessionContext,
  ): Promise<{ role: HelpWantedRole; stateApply: StateApply }> {
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    const role = this.#roleOrThrow(project.id, roleId);
    requireAuth('maintainer | staff', { session, project, memberships });

    const now = nowIso();
    const updated: HelpWantedRole = HelpWantedRoleSchema.parse({
      ...role,
      status: 'closed',
      closedAt: now,
      updatedAt: now,
    });

    await tx.public['help-wanted-roles'].upsert(
      withProjectPath(updated, project.slug) as unknown as HelpWantedRole,
    );

    const stateApply = new StateApply().upsertHelpWantedRole(updated);
    return { role: updated, stateApply };
  }

  async reopen(
    tx: DualStoreTx,
    projectSlug: string,
    roleId: string,
    session: SessionContext,
  ): Promise<{ role: HelpWantedRole; stateApply: StateApply }> {
    const { project, memberships } = this.#projectOrThrow(projectSlug);
    const role = this.#roleOrThrow(project.id, roleId);
    requireAuth('maintainer | staff', { session, project, memberships });

    const updated: HelpWantedRole = HelpWantedRoleSchema.parse({
      ...role,
      status: 'open',
      filledAt: null,
      filledById: null,
      closedAt: null,
      updatedAt: nowIso(),
    });

    await tx.public['help-wanted-roles'].upsert(
      withProjectPath(updated, project.slug) as unknown as HelpWantedRole,
    );

    const stateApply = new StateApply().upsertHelpWantedRole(updated);
    return { role: updated, stateApply };
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

  #roleOrThrow(projectId: string, roleId: string): HelpWantedRole {
    const r = this.#state.helpWantedRoles.get(roleId);
    if (!r || r.projectId !== projectId) {
      throw new ApiNotFoundError(`Help-wanted role '${roleId}' not found`);
    }
    return r;
  }

  #buildTagInputs(
    tags: { topic?: string[]; tech?: string[]; event?: string[] },
  ): TagAssignmentInput[] {
    const out: TagAssignmentInput[] = [];
    for (const ns of ['topic', 'tech', 'event'] as const) {
      const slugs = tags[ns] ?? [];
      for (const s of slugs) out.push({ namespace: ns, slug: s });
    }
    return out;
  }
}
