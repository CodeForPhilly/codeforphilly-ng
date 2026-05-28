/**
 * ProjectService write methods: create, update, soft-delete, restore,
 * change-maintainer + slug-rename machinery.
 *
 * Each method takes a `tx` (dual-store transaction context) and an actor
 * session. It stages gitsheets writes inside the transaction and returns
 * a `StateApply` plus the materialized record. The route applies the
 * StateApply to in-memory state after the transaction commits.
 */
import { uuidv7 } from 'uuidv7';
import { ProjectSchema, ProjectMembershipSchema, type Project, type ProjectMembership } from '@cfp/shared/schemas';
import type { DualStoreTx } from '../store/store.js';
import { StateApply } from '../store/state-apply.js';
import type { InMemoryState } from '../store/memory/state.js';
import {
  ApiNotFoundError,
  ApiValidationError,
  ConflictError,
} from '../lib/errors.js';
import {
  ensureUniqueSlug,
  isReservedSlug,
  isValidProjectSlug,
  slugify,
} from '../lib/slug.js';
import { requireAuth } from '../auth/require.js';
import type { SessionContext } from '../auth/middleware.js';
import { applyTagsForEntity, type TagAssignmentInput } from './tag.write.js';

export interface CreateProjectInput {
  readonly title: string;
  readonly slug?: string;
  readonly summary?: string | null;
  readonly overview?: string | null;
  readonly usersUrl?: string | null;
  readonly developersUrl?: string | null;
  readonly chatChannel?: string | null;
  readonly stage?: string;
  readonly tags?: {
    readonly topic?: string[];
    readonly tech?: string[];
    readonly event?: string[];
  };
}

export interface UpdateProjectInput {
  readonly title?: string;
  readonly slug?: string;
  readonly summary?: string | null;
  readonly overview?: string | null;
  readonly usersUrl?: string | null;
  readonly developersUrl?: string | null;
  readonly chatChannel?: string | null;
  readonly stage?: string;
  readonly tags?: {
    readonly topic?: string[];
    readonly tech?: string[];
    readonly event?: string[];
  };
  readonly featured?: boolean;
  readonly featuredImageKey?: string | null;
}

export interface ProjectWriteResult {
  readonly project: Project;
  readonly stateApply: StateApply;
}

const VALID_STAGES = new Set([
  'commenting',
  'bootstrapping',
  'prototyping',
  'testing',
  'maintaining',
  'drifting',
  'hibernating',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function isStaff(session: SessionContext): boolean {
  return session.accountLevel === 'staff' || session.accountLevel === 'administrator';
}

/**
 * Add the gitsheets path-template fields (e.g. projectSlug, personSlug) to
 * a record before upserting. These are not part of the Zod schema but the
 * .gitsheets sheet config templates reference them.
 */
function withMembershipPath(m: ProjectMembership, projectSlug: string, personSlug: string): Record<string, unknown> {
  return { ...m, projectSlug, personSlug };
}


export class ProjectWriteService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  async create(
    tx: DualStoreTx,
    input: CreateProjectInput,
    session: SessionContext,
  ): Promise<ProjectWriteResult> {
    requireAuth('user', { session });

    if (!input.title || input.title.length === 0 || input.title.length > 200) {
      throw new ApiValidationError('title is required and must be 1-200 chars', {
        title: 'required, 1-200 chars',
      });
    }

    // Resolve slug
    let slug: string;
    if (input.slug) {
      slug = input.slug.toLowerCase();
      if (!isValidProjectSlug(slug)) {
        throw new ApiValidationError('Invalid slug format', { slug: 'invalid format' });
      }
      if (isReservedSlug(slug)) {
        throw new ApiValidationError('Slug is reserved', { slug: 'slug_reserved' });
      }
      if (this.#state.projectIdBySlug.has(slug)) {
        throw new ConflictError(`Slug '${slug}' is already taken`, 'slug_taken');
      }
    } else {
      const base = slugify(input.title, 80);
      if (!base) {
        throw new ApiValidationError('Could not derive slug from title; provide one explicitly', {
          slug: 'required',
        });
      }
      slug = ensureUniqueSlug(base, (s) => this.#state.projectIdBySlug.has(s) || isReservedSlug(s), 80);
    }

    // Stage
    if (input.stage && !VALID_STAGES.has(input.stage)) {
      throw new ApiValidationError('Invalid stage value', { stage: 'invalid' });
    }
    const stage = (input.stage ?? 'commenting') as Project['stage'];

    const id = uuidv7();
    const now = nowIso();

    const project: Project = ProjectSchema.parse({
      id,
      slug,
      title: input.title,
      summary: input.summary ?? null,
      overview: input.overview ?? null,
      stage,
      maintainerId: session.person!.id,
      usersUrl: input.usersUrl ?? null,
      developersUrl: input.developersUrl ?? null,
      chatChannel: input.chatChannel ?? null,
      featured: false,
      createdAt: now,
      updatedAt: now,
    });

    const stateApply = new StateApply();

    await tx.public.projects.upsert(project);
    stateApply.upsertProject(project);

    // Founder membership
    const membership: ProjectMembership = ProjectMembershipSchema.parse({
      id: uuidv7(),
      projectId: project.id,
      personId: session.person!.id,
      role: 'Founder',
      isMaintainer: true,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await tx.public['project-memberships'].upsert(
      withMembershipPath(membership, slug, session.person!.slug) as unknown as ProjectMembership,
    );
    stateApply.upsertMembership(membership);

    // Tags
    if (input.tags) {
      const requested = this.#buildTagInputs(input.tags);
      await applyTagsForEntity(tx, {
        taggableType: 'project',
        taggableId: project.id,
        assignedById: session.person!.id,
        state: this.#state,
        requested,
        session,
        stateApply,
        existing: [],
      });
    }

    return { project, stateApply };
  }

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------

  async update(
    tx: DualStoreTx,
    slug: string,
    input: UpdateProjectInput,
    session: SessionContext,
  ): Promise<ProjectWriteResult> {
    const existing = this.#requireExisting(slug);
    const memberships = this.#membershipsFor(existing.id);

    requireAuth('maintainer | staff', { session, project: existing, memberships });

    const staff = isStaff(session);

    // Staff-only fields
    if (!staff) {
      if (input.slug !== undefined && input.slug !== existing.slug) {
        throw new ApiValidationError('Only staff can change project slug', {
          slug: 'staff_only',
        });
      }
      if (input.featured !== undefined && input.featured !== existing.featured) {
        throw new ApiValidationError('Only staff can change featured flag', {
          featured: 'staff_only',
        });
      }
      if (input.featuredImageKey !== undefined && input.featuredImageKey !== existing.featuredImageKey) {
        throw new ApiValidationError('Only staff can change featuredImageKey', {
          featuredImageKey: 'staff_only',
        });
      }
    }

    if (input.stage !== undefined && !VALID_STAGES.has(input.stage)) {
      throw new ApiValidationError('Invalid stage value', { stage: 'invalid' });
    }

    let newSlug = existing.slug;
    let slugRename: { oldSlug: string; newSlug: string } | null = null;

    if (input.slug !== undefined && input.slug !== existing.slug) {
      const candidate = input.slug.toLowerCase();
      if (!isValidProjectSlug(candidate)) {
        throw new ApiValidationError('Invalid slug format', { slug: 'invalid format' });
      }
      if (isReservedSlug(candidate)) {
        throw new ApiValidationError('Slug is reserved', { slug: 'slug_reserved' });
      }
      if (this.#state.projectIdBySlug.has(candidate)) {
        throw new ConflictError(`Slug '${candidate}' is already taken`, 'slug_taken');
      }
      newSlug = candidate;
      slugRename = { oldSlug: existing.slug, newSlug: candidate };
    }

    const now = nowIso();
    const updated: Project = ProjectSchema.parse({
      ...existing,
      title: input.title ?? existing.title,
      slug: newSlug,
      summary: input.summary === undefined ? (existing.summary ?? null) : input.summary,
      overview: input.overview === undefined ? (existing.overview ?? null) : input.overview,
      usersUrl: input.usersUrl === undefined ? (existing.usersUrl ?? null) : input.usersUrl,
      developersUrl:
        input.developersUrl === undefined ? (existing.developersUrl ?? null) : input.developersUrl,
      chatChannel:
        input.chatChannel === undefined ? (existing.chatChannel ?? null) : input.chatChannel,
      stage: (input.stage ?? existing.stage) as Project['stage'],
      featured: input.featured ?? existing.featured,
      featuredImageKey:
        input.featuredImageKey === undefined
          ? (existing.featuredImageKey ?? null)
          : input.featuredImageKey,
      updatedAt: now,
    });

    const stateApply = new StateApply();

    if (slugRename) {
      // Delete the old path first, then upsert at the new path.
      await tx.public.projects.delete(existing);
      // SlugHistory record
      const history = {
        id: uuidv7(),
        entityType: 'project' as const,
        oldSlug: slugRename.oldSlug,
        newSlug: slugRename.newSlug,
        entityId: existing.id,
        changedAt: now,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      };
      await tx.public['slug-history'].upsert(history);
      stateApply.renameProjectSlug(existing.id, slugRename.oldSlug, slugRename.newSlug);
      stateApply.upsertSlugHistory(history);
    }

    await tx.public.projects.upsert(updated);
    stateApply.upsertProject(updated);

    // Tag replacement (per-namespace)
    if (input.tags) {
      const existingTas = [...(this.#state.tagAssignmentsByTaggable.get(existing.id) ?? [])]
        .map((taId) => this.#state.tagAssignments.get(taId))
        .filter((ta): ta is NonNullable<typeof ta> => ta?.taggableType === 'project');
      await applyTagsForEntity(tx, {
        taggableType: 'project',
        taggableId: existing.id,
        assignedById: session.person?.id ?? null,
        state: this.#state,
        requested: this.#buildTagInputs(input.tags),
        replaceNamespaces: Object.keys(input.tags) as Array<'topic' | 'tech' | 'event'>,
        existing: existingTas,
        session,
        stateApply,
      });
    }

    return { project: updated, stateApply };
  }

  // ---------------------------------------------------------------------------
  // softDelete / restore
  // ---------------------------------------------------------------------------

  async softDelete(
    tx: DualStoreTx,
    slug: string,
    session: SessionContext,
  ): Promise<{ stateApply: StateApply }> {
    const existing = this.#requireExisting(slug);
    const memberships = this.#membershipsFor(existing.id);
    requireAuth('staff', { session, project: existing, memberships });

    if (existing.deletedAt) {
      // Idempotent — already soft-deleted
      return { stateApply: new StateApply() };
    }

    const now = nowIso();
    const updated: Project = ProjectSchema.parse({
      ...existing,
      deletedAt: now,
      updatedAt: now,
    });

    await tx.public.projects.upsert(updated);

    const stateApply = new StateApply();
    stateApply.upsertProject(updated);
    return { stateApply };
  }

  async restore(
    tx: DualStoreTx,
    slug: string,
    session: SessionContext,
  ): Promise<ProjectWriteResult> {
    const existing = this.#requireExistingIncludingDeleted(slug);
    const memberships = this.#membershipsFor(existing.id);
    requireAuth('staff', { session, project: existing, memberships });

    const now = nowIso();
    const updated: Project = ProjectSchema.parse({
      ...existing,
      deletedAt: null,
      updatedAt: now,
    });

    await tx.public.projects.upsert(updated);

    const stateApply = new StateApply();
    stateApply.upsertProject(updated);
    return { project: updated, stateApply };
  }

  // ---------------------------------------------------------------------------
  // change-maintainer
  // ---------------------------------------------------------------------------

  async changeMaintainer(
    tx: DualStoreTx,
    slug: string,
    newMaintainerSlug: string,
    session: SessionContext,
  ): Promise<ProjectWriteResult> {
    const existing = this.#requireExisting(slug);
    const memberships = this.#membershipsFor(existing.id);
    requireAuth('maintainer | staff', { session, project: existing, memberships });

    const newMaintainerId = this.#state.personIdBySlug.get(newMaintainerSlug);
    if (!newMaintainerId) {
      throw new ApiNotFoundError(`Person '${newMaintainerSlug}' not found`);
    }
    const newMaintainerPerson = this.#state.people.get(newMaintainerId);
    if (!newMaintainerPerson) {
      throw new ApiNotFoundError(`Person '${newMaintainerSlug}' not found`);
    }

    const newMaintainerMembership = memberships.find((m) => m.personId === newMaintainerId);
    if (!newMaintainerMembership) {
      throw new ConflictError(
        `${newMaintainerSlug} is not a member of this project`,
        'not_a_member',
      );
    }

    const now = nowIso();
    const stateApply = new StateApply();

    // Old maintainer keeps membership; flip isMaintainer where appropriate.
    const oldMaintainerMembership = memberships.find(
      (m) => m.personId === existing.maintainerId && m.isMaintainer,
    );
    if (oldMaintainerMembership && oldMaintainerMembership.personId !== newMaintainerId) {
      const updatedOld: ProjectMembership = ProjectMembershipSchema.parse({
        ...oldMaintainerMembership,
        isMaintainer: false,
        role: oldMaintainerMembership.role ?? 'Maintainer (former)',
        updatedAt: now,
      });
      const oldPerson = this.#state.people.get(updatedOld.personId);
      await tx.public['project-memberships'].upsert(
        withMembershipPath(updatedOld, existing.slug, oldPerson?.slug ?? 'unknown') as unknown as ProjectMembership,
      );
      stateApply.upsertMembership(updatedOld);
    }

    const updatedNew: ProjectMembership = ProjectMembershipSchema.parse({
      ...newMaintainerMembership,
      isMaintainer: true,
      updatedAt: now,
    });
    await tx.public['project-memberships'].upsert(
      withMembershipPath(updatedNew, existing.slug, newMaintainerPerson.slug) as unknown as ProjectMembership,
    );
    stateApply.upsertMembership(updatedNew);

    const updatedProject: Project = ProjectSchema.parse({
      ...existing,
      maintainerId: newMaintainerId,
      updatedAt: now,
    });
    await tx.public.projects.upsert(updatedProject);
    stateApply.upsertProject(updatedProject);

    return { project: updatedProject, stateApply };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  #requireExisting(slug: string): Project {
    const id = this.#state.projectIdBySlug.get(slug);
    if (!id) throw new ApiNotFoundError(`Project '${slug}' not found`);
    const p = this.#state.projects.get(id);
    if (!p || p.deletedAt) throw new ApiNotFoundError(`Project '${slug}' not found`);
    return p;
  }

  #requireExistingIncludingDeleted(slug: string): Project {
    const id = this.#state.projectIdBySlug.get(slug);
    if (!id) throw new ApiNotFoundError(`Project '${slug}' not found`);
    const p = this.#state.projects.get(id);
    if (!p) throw new ApiNotFoundError(`Project '${slug}' not found`);
    return p;
  }

  #membershipsFor(projectId: string): ProjectMembership[] {
    const mIds = this.#state.membershipsByProject.get(projectId) ?? new Set();
    return [...mIds]
      .map((id) => this.#state.projectMemberships.get(id))
      .filter((m): m is ProjectMembership => m !== undefined);
  }

  #buildTagInputs(tags: NonNullable<CreateProjectInput['tags']>): TagAssignmentInput[] {
    const out: TagAssignmentInput[] = [];
    for (const ns of ['topic', 'tech', 'event'] as const) {
      const slugs = tags[ns] ?? [];
      for (const s of slugs) out.push({ namespace: ns, slug: s });
    }
    return out;
  }
}
