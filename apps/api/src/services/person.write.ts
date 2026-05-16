/**
 * Person writes:
 *  - PATCH  /api/people/:slug            (self | staff)
 *  - DELETE /api/people/:slug            (administrator)
 *  - PATCH  /api/people/:slug/newsletter (self | staff) — private-store only
 *
 * Avatar upload is handled by a separate multipart route handler that
 * stages an attachment then calls a Person update; it is not covered by
 * this service in v1.
 */
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import {
  PersonSchema,
  PrivateProfileSchema,
  type Person,
  type PrivateProfile,
} from '@cfp/shared/schemas';
import type { DualStoreTx } from '../store/store.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import {
  ApiNotFoundError,
  ApiValidationError,
  ConflictError,
} from '../lib/errors.js';
import {
  isReservedSlug,
  isValidPersonSlug,
} from '../lib/slug.js';
import { requireAuth } from '../auth/require.js';
import type { SessionContext } from '../auth/middleware.js';
import { applyTagsForEntity, type TagAssignmentInput, type TagNamespace } from './tag.write.js';
import type { PrivateStore } from '../store/private/index.js';

function nowIso(): string {
  return new Date().toISOString();
}

function unsubscribeToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface UpdatePersonInput {
  readonly fullName?: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly bio?: string | null;
  readonly slug?: string;
  readonly email?: string;
  readonly slackHandle?: string | null;
  readonly tags?: {
    readonly topic?: string[];
    readonly tech?: string[];
  };
}

export class PersonWriteService {
  readonly #state: InMemoryState;
  readonly #privateStore: PrivateStore;

  constructor(state: InMemoryState, privateStore: PrivateStore) {
    this.#state = state;
    this.#privateStore = privateStore;
  }

  async update(
    tx: DualStoreTx,
    slug: string,
    input: UpdatePersonInput,
    session: SessionContext,
  ): Promise<{ person: Person; stateApply: StateApply }> {
    const existing = this.#personOrThrow(slug);
    requireAuth('self | staff', { session, selfId: existing.id });

    let newSlug = existing.slug;
    if (input.slug !== undefined && input.slug !== existing.slug) {
      const candidate = input.slug.toLowerCase();
      if (!isValidPersonSlug(candidate)) {
        throw new ApiValidationError('Invalid slug format', { slug: 'invalid format' });
      }
      if (isReservedSlug(candidate)) {
        throw new ApiValidationError('Slug is reserved', { slug: 'slug_reserved' });
      }
      if (this.#state.personIdBySlug.has(candidate)) {
        throw new ConflictError(`Slug '${candidate}' is already taken`, 'slug_taken');
      }
      newSlug = candidate;
    }

    // Email uniqueness (private store)
    if (input.email !== undefined) {
      const normalized = input.email.toLowerCase();
      const ownerId = await this.#privateStore.findPersonIdByEmail(normalized);
      if (ownerId && ownerId !== existing.id) {
        throw new ConflictError(`Email is already in use`, 'email_taken');
      }
    }

    const now = nowIso();
    const updated: Person = PersonSchema.parse({
      ...existing,
      fullName: input.fullName ?? existing.fullName,
      firstName: input.firstName === undefined ? (existing.firstName ?? null) : input.firstName,
      lastName: input.lastName === undefined ? (existing.lastName ?? null) : input.lastName,
      bio: input.bio === undefined ? (existing.bio ?? null) : input.bio,
      slackHandle:
        input.slackHandle === undefined ? (existing.slackHandle ?? null) : input.slackHandle,
      slug: newSlug,
      updatedAt: now,
    });

    const stateApply = new StateApply();

    if (newSlug !== existing.slug) {
      await tx.public.people.delete(existing);
      const history = {
        id: uuidv7(),
        entityType: 'person' as const,
        oldSlug: existing.slug,
        newSlug,
        entityId: existing.id,
        changedAt: now,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      };
      await tx.public['slug-history'].upsert(history);
      stateApply.renamePersonSlug(existing.id, existing.slug, newSlug);
    }

    await tx.public.people.upsert(updated);
    stateApply.upsertPerson(updated);

    // Email change → private profile update (no public diff)
    if (input.email !== undefined) {
      const existingProfile = await this.#privateStore.getProfile(existing.id);
      const profile: PrivateProfile = PrivateProfileSchema.parse({
        personId: existing.id,
        email: input.email.toLowerCase(),
        emailRefreshedAt: now,
        newsletter: existingProfile?.newsletter ?? null,
        updatedAt: now,
      });
      tx.private.putProfile(profile);
    }

    if (input.tags) {
      const existingTas = [...(this.#state.tagAssignmentsByTaggable.get(existing.id) ?? [])]
        .map((taId) => this.#state.tagAssignments.get(taId))
        .filter((ta): ta is NonNullable<typeof ta> => ta?.taggableType === 'person');
      await applyTagsForEntity(tx, {
        taggableType: 'person',
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

    return { person: updated, stateApply };
  }

  async softDelete(
    tx: DualStoreTx,
    slug: string,
    session: SessionContext,
  ): Promise<{ stateApply: StateApply }> {
    const existing = this.#personOrThrow(slug);
    requireAuth('administrator', { session });

    if (existing.deletedAt) {
      return { stateApply: new StateApply() };
    }

    const now = nowIso();
    const updated: Person = PersonSchema.parse({
      ...existing,
      deletedAt: now,
      updatedAt: now,
    });

    await tx.public.people.upsert(updated);

    const stateApply = new StateApply().upsertPerson(updated);
    return { stateApply };
  }

  async updateNewsletter(
    slug: string,
    optedIn: boolean,
    session: SessionContext,
  ): Promise<{ profile: PrivateProfile }> {
    const existing = this.#personOrThrow(slug);
    requireAuth('self | staff', { session, selfId: existing.id });

    const current = await this.#privateStore.getProfile(existing.id);
    if (!current) {
      throw new ApiNotFoundError(`No private profile for '${slug}'`);
    }

    const now = nowIso();
    const newsletter = current.newsletter ?? null;

    const updatedNewsletter = optedIn
      ? {
          optedIn: true,
          optedInAt: now,
          optedOutAt: newsletter?.optedOutAt ?? null,
          unsubscribeToken: newsletter?.unsubscribeToken ?? unsubscribeToken(),
        }
      : {
          optedIn: false,
          optedInAt: newsletter?.optedInAt ?? null,
          optedOutAt: now,
          unsubscribeToken: newsletter?.unsubscribeToken ?? null,
        };

    const profile: PrivateProfile = PrivateProfileSchema.parse({
      ...current,
      newsletter: updatedNewsletter,
      updatedAt: now,
    });

    // Private-only mutation — no public commit
    await this.#privateStore.putProfile(profile);
    return { profile };
  }

  #personOrThrow(slug: string): Person {
    const id = this.#state.personIdBySlug.get(slug);
    if (!id) throw new ApiNotFoundError(`Person '${slug}' not found`);
    const p = this.#state.people.get(id);
    if (!p || p.deletedAt) throw new ApiNotFoundError(`Person '${slug}' not found`);
    return p;
  }

  #buildTagInputs(
    tags: NonNullable<UpdatePersonInput['tags']>,
  ): TagAssignmentInput[] {
    const out: TagAssignmentInput[] = [];
    for (const ns of ['topic', 'tech'] as const) {
      const slugs = tags[ns] ?? [];
      for (const s of slugs) out.push({ namespace: ns, slug: s });
    }
    return out;
  }
}

