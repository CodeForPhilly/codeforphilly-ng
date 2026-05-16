/**
 * Project buzz writes:
 *  - POST   /api/projects/:slug/buzz            (user)
 *  - PATCH  /api/projects/:slug/buzz/:buzzSlug  (poster | staff)
 *  - DELETE /api/projects/:slug/buzz/:buzzSlug  (poster | staff)
 */
import { uuidv7 } from 'uuidv7';
import { ProjectBuzzSchema, type Project, type ProjectBuzz } from '@cfp/shared/schemas';
import type { DualStoreTx } from '../store/store.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import { ApiNotFoundError, ApiValidationError, ConflictError } from '../lib/errors.js';
import { ensureUniqueSlug, isValidBuzzSlug, slugify } from '../lib/slug.js';
import { requireAuth } from '../auth/require.js';
import type { SessionContext } from '../auth/middleware.js';

function nowIso(): string {
  return new Date().toISOString();
}

function withProjectPath<T extends object>(record: T, projectSlug: string): Record<string, unknown> {
  return { ...record, projectSlug };
}

function normalizePublishedAt(input: string): string {
  // Accept date-only (yyyy-mm-dd) and normalize to T00:00:00Z
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return `${input}T00:00:00Z`;
  }
  // Otherwise assume an ISO-8601 datetime; pass through
  return input;
}

export class ProjectBuzzWriteService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  async create(
    tx: DualStoreTx,
    projectSlug: string,
    input: {
      headline: string;
      url: string;
      publishedAt: string;
      summary?: string | null;
      imageUpload?: { key: string } | null;
    },
    session: SessionContext,
  ): Promise<{ buzz: ProjectBuzz; stateApply: StateApply }> {
    requireAuth('user', { session });
    const project = this.#projectOrThrow(projectSlug);

    if (!input.headline || input.headline.length < 1 || input.headline.length > 200) {
      throw new ApiValidationError('headline required, 1-200 chars', { headline: 'required' });
    }
    if (!input.url || !input.url.startsWith('https://')) {
      throw new ApiValidationError('url required, must be https', { url: 'required' });
    }

    const publishedAt = normalizePublishedAt(input.publishedAt);

    // Uniqueness on (projectId, url)
    for (const id of this.#state.buzzByProject.get(project.id) ?? new Set()) {
      const b = this.#state.projectBuzz.get(id);
      if (b && b.url === input.url) {
        throw new ConflictError('URL already logged for this project', 'duplicate_url');
      }
    }

    // Slug derivation
    const baseSlug = slugify(input.headline, 100);
    if (!baseSlug) {
      throw new ApiValidationError('Could not derive a buzz slug from headline', {
        headline: 'unusable',
      });
    }
    const slug = ensureUniqueSlug(
      baseSlug,
      (s) => this.#state.buzzByProjectAndSlug.has(`${project.id}:${s}`),
      100,
    );
    if (!isValidBuzzSlug(slug)) {
      throw new ApiValidationError('Generated slug is invalid', { headline: 'unusable' });
    }

    const now = nowIso();
    const buzz: ProjectBuzz = ProjectBuzzSchema.parse({
      id: uuidv7(),
      projectId: project.id,
      postedById: session.person!.id,
      slug,
      headline: input.headline,
      url: input.url,
      publishedAt,
      summary: input.summary ?? null,
      imageKey: input.imageUpload?.key ?? null,
      createdAt: now,
      updatedAt: now,
    });

    await tx.public['project-buzz'].upsert(
      withProjectPath(buzz, project.slug) as unknown as ProjectBuzz,
    );

    const stateApply = new StateApply().upsertProjectBuzz(buzz);
    return { buzz, stateApply };
  }

  async update(
    tx: DualStoreTx,
    projectSlug: string,
    buzzSlug: string,
    input: {
      headline?: string;
      url?: string;
      publishedAt?: string;
      summary?: string | null;
      imageUpload?: { key: string } | null;
      regenerateSlug?: boolean;
    },
    session: SessionContext,
  ): Promise<{ buzz: ProjectBuzz; stateApply: StateApply }> {
    const project = this.#projectOrThrow(projectSlug);
    const existing = this.#buzzOrThrow(project.id, buzzSlug);
    requireAuth('poster | staff', { session, ownerId: existing.postedById ?? undefined });

    if (input.headline !== undefined && (input.headline.length < 1 || input.headline.length > 200)) {
      throw new ApiValidationError('headline 1-200 chars', { headline: 'invalid' });
    }
    if (input.url !== undefined && !input.url.startsWith('https://')) {
      throw new ApiValidationError('url must be https', { url: 'invalid' });
    }

    // URL change must remain unique within project
    if (input.url !== undefined && input.url !== existing.url) {
      for (const id of this.#state.buzzByProject.get(project.id) ?? new Set()) {
        if (id === existing.id) continue;
        const b = this.#state.projectBuzz.get(id);
        if (b && b.url === input.url) {
          throw new ConflictError('URL already logged for this project', 'duplicate_url');
        }
      }
    }

    let newSlug = existing.slug;
    let slugChanged = false;
    if (input.regenerateSlug && input.headline !== undefined) {
      const base = slugify(input.headline, 100);
      if (!base) {
        throw new ApiValidationError('Could not derive a buzz slug from headline', {
          headline: 'unusable',
        });
      }
      newSlug = ensureUniqueSlug(
        base,
        (s) =>
          s !== existing.slug && this.#state.buzzByProjectAndSlug.has(`${project.id}:${s}`),
        100,
      );
      slugChanged = newSlug !== existing.slug;
    }

    const updated: ProjectBuzz = ProjectBuzzSchema.parse({
      ...existing,
      headline: input.headline ?? existing.headline,
      url: input.url ?? existing.url,
      publishedAt:
        input.publishedAt === undefined ? existing.publishedAt : normalizePublishedAt(input.publishedAt),
      summary: input.summary === undefined ? (existing.summary ?? null) : input.summary,
      imageKey:
        input.imageUpload === undefined
          ? (existing.imageKey ?? null)
          : (input.imageUpload?.key ?? null),
      slug: newSlug,
      updatedAt: nowIso(),
    });

    const stateApply = new StateApply();

    if (slugChanged) {
      await tx.public['project-buzz'].delete(
        withProjectPath(existing, project.slug) as unknown as ProjectBuzz,
      );
      stateApply.removeProjectBuzz(existing);
    }

    await tx.public['project-buzz'].upsert(
      withProjectPath(updated, project.slug) as unknown as ProjectBuzz,
    );
    stateApply.upsertProjectBuzz(updated);

    return { buzz: updated, stateApply };
  }

  async delete(
    tx: DualStoreTx,
    projectSlug: string,
    buzzSlug: string,
    session: SessionContext,
  ): Promise<{ stateApply: StateApply }> {
    const project = this.#projectOrThrow(projectSlug);
    const existing = this.#buzzOrThrow(project.id, buzzSlug);
    requireAuth('poster | staff', { session, ownerId: existing.postedById ?? undefined });

    await tx.public['project-buzz'].delete(
      withProjectPath(existing, project.slug) as unknown as ProjectBuzz,
    );

    const stateApply = new StateApply().removeProjectBuzz(existing);
    return { stateApply };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  #projectOrThrow(slug: string): Project {
    const id = this.#state.projectIdBySlug.get(slug);
    if (!id) throw new ApiNotFoundError(`Project '${slug}' not found`);
    const p = this.#state.projects.get(id);
    if (!p || p.deletedAt) throw new ApiNotFoundError(`Project '${slug}' not found`);
    return p;
  }

  #buzzOrThrow(projectId: string, buzzSlug: string): ProjectBuzz {
    const id = this.#state.buzzByProjectAndSlug.get(`${projectId}:${buzzSlug}`);
    if (!id) throw new ApiNotFoundError(`Buzz '${buzzSlug}' not found`);
    const b = this.#state.projectBuzz.get(id);
    if (!b) throw new ApiNotFoundError(`Buzz '${buzzSlug}' not found`);
    return b;
  }
}
