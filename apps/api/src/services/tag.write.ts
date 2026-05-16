/**
 * TagService writes: create / update / merge / delete (all staff-only) plus
 * the polymorphic `applyTagsForEntity` helper used by project, person, and
 * help-wanted role writes to reconcile the tag set against a request body.
 */
import { uuidv7 } from 'uuidv7';
import {
  TagAssignmentSchema,
  TagSchema,
  type Tag,
  type TagAssignment,
} from '@cfp/shared/schemas';
import type { DualStoreTx } from '../store/store.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import {
  ApiNotFoundError,
  ApiValidationError,
  ConflictError,
} from '../lib/errors.js';
import { isValidTagSlug } from '../lib/slug.js';
import { requireAuth } from '../auth/require.js';
import type { SessionContext } from '../auth/middleware.js';

export type TagNamespace = 'topic' | 'tech' | 'event';

export interface TagAssignmentInput {
  readonly namespace: TagNamespace;
  readonly slug: string;
}

const VALID_NAMESPACES: ReadonlySet<TagNamespace> = new Set(['topic', 'tech', 'event']);

function nowIso(): string {
  return new Date().toISOString();
}

function isStaff(session: SessionContext): boolean {
  return session.accountLevel === 'staff' || session.accountLevel === 'administrator';
}

export class TagWriteService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  async create(
    tx: DualStoreTx,
    input: { namespace: string; slug: string; title: string },
    session: SessionContext,
  ): Promise<{ tag: Tag; stateApply: StateApply }> {
    requireAuth('staff', { session });

    if (!VALID_NAMESPACES.has(input.namespace as TagNamespace)) {
      throw new ApiValidationError('Invalid namespace', { namespace: 'invalid' });
    }
    if (!isValidTagSlug(input.slug)) {
      throw new ApiValidationError('Invalid slug format', { slug: 'invalid format' });
    }
    if (!input.title || input.title.length === 0 || input.title.length > 80) {
      throw new ApiValidationError('title required, 1-80 chars', { title: 'required' });
    }

    const handle = `${input.namespace}.${input.slug}`;
    if (this.#state.tagIdByHandle.has(handle)) {
      throw new ConflictError(`Tag '${handle}' already exists`, 'tag_taken');
    }

    const now = nowIso();
    const tag: Tag = TagSchema.parse({
      id: uuidv7(),
      namespace: input.namespace,
      slug: input.slug,
      title: input.title,
      createdAt: now,
      updatedAt: now,
    });

    await tx.public.tags.upsert(tag);

    const stateApply = new StateApply().upsertTag(tag);
    return { tag, stateApply };
  }

  // ---------------------------------------------------------------------------
  // update / merge
  // ---------------------------------------------------------------------------

  async update(
    tx: DualStoreTx,
    handle: string,
    input: { title?: string; mergeInto?: string },
    session: SessionContext,
  ): Promise<{ tag: Tag; stateApply: StateApply }> {
    requireAuth('staff', { session });

    const tagId = this.#state.tagIdByHandle.get(handle);
    if (!tagId) throw new ApiNotFoundError(`Tag '${handle}' not found`);
    const tag = this.#state.tags.get(tagId);
    if (!tag) throw new ApiNotFoundError(`Tag '${handle}' not found`);

    if (input.mergeInto) {
      return this.#merge(tx, tag, input.mergeInto);
    }

    if (input.title !== undefined) {
      if (input.title.length === 0 || input.title.length > 80) {
        throw new ApiValidationError('title required, 1-80 chars', { title: 'required' });
      }
      const updated = TagSchema.parse({ ...tag, title: input.title, updatedAt: nowIso() });
      await tx.public.tags.upsert(updated);
      const stateApply = new StateApply().upsertTag(updated);
      return { tag: updated, stateApply };
    }

    // No-op
    return { tag, stateApply: new StateApply() };
  }

  async #merge(
    tx: DualStoreTx,
    source: Tag,
    targetHandle: string,
  ): Promise<{ tag: Tag; stateApply: StateApply }> {
    const targetId = this.#state.tagIdByHandle.get(targetHandle);
    if (!targetId) {
      throw new ConflictError(`Merge target '${targetHandle}' not found`, 'merge_target_missing');
    }
    const target = this.#state.tags.get(targetId);
    if (!target) {
      throw new ConflictError(`Merge target '${targetHandle}' not found`, 'merge_target_missing');
    }
    if (target.namespace !== source.namespace) {
      throw new ConflictError(
        `Merge target '${targetHandle}' is in a different namespace`,
        'merge_namespace_mismatch',
      );
    }
    if (target.id === source.id) {
      throw new ApiValidationError('Cannot merge a tag into itself', { mergeInto: 'same_tag' });
    }

    const stateApply = new StateApply();

    // Reassign all assignments — delete sources, upsert duplicates onto target
    const sourceAssignmentIds = this.#state.tagAssignmentsByTag.get(source.id) ?? new Set();
    for (const taId of sourceAssignmentIds) {
      const ta = this.#state.tagAssignments.get(taId);
      if (!ta) continue;
      // If the same taggable already has the target tag, just delete the source
      const targetAssignmentsForTaggable = this.#state.tagAssignmentsByTaggable.get(ta.taggableId);
      const alreadyHasTarget =
        targetAssignmentsForTaggable !== undefined &&
        [...targetAssignmentsForTaggable]
          .map((id) => this.#state.tagAssignments.get(id))
          .some((t) => t?.tagId === target.id);

      await tx.public['tag-assignments'].delete(ta);
      stateApply.removeTagAssignment(ta);

      if (!alreadyHasTarget) {
        const newAssignment: TagAssignment = TagAssignmentSchema.parse({
          id: uuidv7(),
          tagId: target.id,
          taggableType: ta.taggableType,
          taggableId: ta.taggableId,
          assignedById: ta.assignedById ?? null,
          createdAt: ta.createdAt,
        });
        await tx.public['tag-assignments'].upsert(newAssignment);
        stateApply.upsertTagAssignment(newAssignment);
      }
    }

    await tx.public.tags.delete(source);
    stateApply.removeTag(source.id, `${source.namespace}.${source.slug}`);

    return { tag: target, stateApply };
  }

  // ---------------------------------------------------------------------------
  // delete (cascades through tag-assignments)
  // ---------------------------------------------------------------------------

  async delete(
    tx: DualStoreTx,
    handle: string,
    session: SessionContext,
  ): Promise<{ stateApply: StateApply }> {
    requireAuth('staff', { session });

    const tagId = this.#state.tagIdByHandle.get(handle);
    if (!tagId) throw new ApiNotFoundError(`Tag '${handle}' not found`);
    const tag = this.#state.tags.get(tagId);
    if (!tag) throw new ApiNotFoundError(`Tag '${handle}' not found`);

    const stateApply = new StateApply();

    const assignmentIds = this.#state.tagAssignmentsByTag.get(tagId) ?? new Set();
    for (const taId of assignmentIds) {
      const ta = this.#state.tagAssignments.get(taId);
      if (!ta) continue;
      await tx.public['tag-assignments'].delete(ta);
      stateApply.removeTagAssignment(ta);
    }

    await tx.public.tags.delete(tag);
    stateApply.removeTag(tag.id, handle);

    return { stateApply };
  }
}

// ---------------------------------------------------------------------------
// Polymorphic tag-assignment reconciler
// ---------------------------------------------------------------------------

interface ApplyTagsArgs {
  readonly taggableType: 'project' | 'person' | 'help_wanted_role';
  readonly taggableId: string;
  readonly assignedById: string | null;
  readonly state: InMemoryState;
  readonly requested: TagAssignmentInput[];
  readonly existing: TagAssignment[];
  readonly session: SessionContext;
  readonly stateApply: StateApply;
  /**
   * If present, only re-reconcile assignments within these namespaces.
   * Used by PATCH-style replacements where only certain namespaces appear
   * in the request body.
   */
  readonly replaceNamespaces?: ReadonlyArray<TagNamespace>;
}

/**
 * Reconcile a polymorphic entity's tag set inside a transaction.
 *
 * - Staff: unknown tag slugs auto-create new tags
 * - Non-staff: unknown tag slug → 422 with `tag_not_found`
 * - Replaces by namespace: only the namespaces present in `requested`
 *   (or `replaceNamespaces` if provided) are touched
 */
export async function applyTagsForEntity(
  tx: DualStoreTx,
  args: ApplyTagsArgs,
): Promise<void> {
  const staff = isStaff(args.session);

  // Validate inputs
  for (const req of args.requested) {
    if (!VALID_NAMESPACES.has(req.namespace)) {
      throw new ApiValidationError(`Invalid tag namespace '${req.namespace}'`, {
        tag: 'invalid_namespace',
      });
    }
    if (!isValidTagSlug(req.slug)) {
      throw new ApiValidationError(`Invalid tag slug '${req.slug}'`, { tag: 'invalid_slug' });
    }
  }

  // Resolve / auto-create tags
  const resolvedByHandle = new Map<string, string>(); // handle → tagId
  for (const req of args.requested) {
    const handle = `${req.namespace}.${req.slug}`;
    if (resolvedByHandle.has(handle)) continue;
    const existingId = args.state.tagIdByHandle.get(handle);
    if (existingId) {
      resolvedByHandle.set(handle, existingId);
      continue;
    }
    if (!staff) {
      throw new ApiValidationError(
        `Unknown tag '${handle}'. Ask staff to create it.`,
        { tag: 'tag_not_found' },
      );
    }
    // Staff: auto-create
    const now = nowIso();
    const newTag: Tag = TagSchema.parse({
      id: uuidv7(),
      namespace: req.namespace,
      slug: req.slug,
      title: req.slug, // title defaults to slug; staff can refine later via PATCH
      createdAt: now,
      updatedAt: now,
    });
    await tx.public.tags.upsert(newTag);
    args.stateApply.upsertTag(newTag);
    resolvedByHandle.set(handle, newTag.id);
  }

  // Determine which existing assignments to keep / delete and which new to add
  const namespacesToTouch: Set<TagNamespace> = args.replaceNamespaces
    ? new Set(args.replaceNamespaces)
    : new Set(args.requested.map((r) => r.namespace));

  const desiredTagIds = new Set(resolvedByHandle.values());
  const existingByTagId = new Map<string, TagAssignment>();
  for (const ta of args.existing) {
    const tag = args.state.tags.get(ta.tagId);
    if (!tag) continue;
    if (!namespacesToTouch.has(tag.namespace as TagNamespace)) continue;
    existingByTagId.set(ta.tagId, ta);
  }

  // Delete those not desired
  for (const [tagId, ta] of existingByTagId) {
    if (!desiredTagIds.has(tagId)) {
      await tx.public['tag-assignments'].delete(ta);
      args.stateApply.removeTagAssignment(ta);
    }
  }

  // Add new
  for (const tagId of desiredTagIds) {
    if (existingByTagId.has(tagId)) continue;
    const newAssignment: TagAssignment = TagAssignmentSchema.parse({
      id: uuidv7(),
      tagId,
      taggableType: args.taggableType,
      taggableId: args.taggableId,
      assignedById: args.assignedById ?? null,
      createdAt: nowIso(),
    });
    await tx.public['tag-assignments'].upsert(newAssignment);
    args.stateApply.upsertTagAssignment(newAssignment);
  }
}
