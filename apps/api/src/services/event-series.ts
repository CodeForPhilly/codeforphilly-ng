/**
 * Event series — specs/behaviors/events.md#series, specs/api/events.md#event-series.
 *
 * A series is a label with a page, never a generator. Reads list a series'
 * events split by upcoming/past; writes are staff-only and a series can be
 * deleted only while nothing references it.
 */
import { uuidv7 } from 'uuidv7';
import { EventSeriesSchema, type Event, type EventSeries } from '@cfp/shared/schemas';

import type { SessionContext } from '../auth/middleware.js';
import { requireAuth } from '../auth/require.js';
import { ApiNotFoundError, ApiValidationError, ConflictError } from '../lib/errors.js';
import { ensureUniqueSlug, isReservedSlug, slugify } from '../lib/slug.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import type { DualStoreTx } from '../store/store.js';
import { EventService, isUpcoming } from './event.js';
import { computeEventSeriesPermissions, type CallerSession, type EventSeriesPermissions } from './permissions.js';
import { renderMarkdown } from './serializers/common.js';
import type { EventSummaryResponse, SeriesRef } from './serializers/event.js';

const SERIES_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,99}$/;

export interface EventSeriesListItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly descriptionHtml: string | null;
  readonly eventCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EventSeriesResponse extends EventSeriesListItem {
  readonly upcoming: EventSummaryResponse[];
  readonly past: EventSummaryResponse[];
  readonly permissions: EventSeriesPermissions;
}

export interface EventSeriesInput {
  title?: string;
  slug?: string | null;
  description?: string | null;
}

function isStaff(caller: CallerSession | undefined): boolean {
  return caller?.accountLevel === 'staff' || caller?.accountLevel === 'administrator';
}

export class EventSeriesService {
  readonly #state: InMemoryState;
  readonly #events: EventService;

  constructor(state: InMemoryState) {
    this.#state = state;
    this.#events = new EventService(state);
  }

  findBySlug(slug: string): EventSeries | undefined {
    const id = this.#state.eventSeriesIdBySlug.get(slug);
    return id ? this.#state.eventSeries.get(id) : undefined;
  }

  ref(seriesId: string | null | undefined): SeriesRef | null {
    if (!seriesId) return null;
    const s = this.#state.eventSeries.get(seriesId);
    return s ? { slug: s.slug, title: s.title } : null;
  }

  /** Events in the series the caller may see (drafts only for staff). */
  eventsOf(series: EventSeries, caller: CallerSession | undefined): Event[] {
    const staff = isStaff(caller);
    const ids = this.#state.eventsBySeries.get(series.id) ?? new Set<string>();
    return [...ids]
      .map((id) => this.#state.events.get(id))
      .filter((e): e is Event => e !== undefined && (staff || e.status !== 'draft'));
  }

  /** A series is visible when it has at least one event the caller may see, or the caller is staff. */
  visible(series: EventSeries, caller: CallerSession | undefined): boolean {
    return isStaff(caller) || this.eventsOf(series, caller).length > 0;
  }

  list(opts: { page?: number; perPage?: number }, caller?: CallerSession): { items: EventSeriesListItem[]; totalItems: number } {
    const all = [...this.#state.eventSeries.values()]
      .filter((s) => this.visible(s, caller))
      .sort((a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug));
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 50));
    const slice = all.slice((page - 1) * perPage, page * perPage);
    return { items: slice.map((s) => this.#item(s, caller)), totalItems: all.length };
  }

  get(slug: string, caller?: CallerSession, now: Date = new Date()): EventSeriesResponse | null {
    const series = this.findBySlug(slug);
    if (!series || !this.visible(series, caller)) return null;
    const events = this.eventsOf(series, caller);
    const upcoming = events.filter((e) => isUpcoming(e, now)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const past = events
      .filter((e) => !isUpcoming(e, now))
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
      .slice(0, 50);
    const total = this.#state.eventsBySeries.get(series.id)?.size ?? 0;
    return {
      ...this.#item(series, caller),
      upcoming: upcoming.map((e) => this.#events.serializeSummary(e, caller)),
      past: past.map((e) => this.#events.serializeSummary(e, caller)),
      permissions: computeEventSeriesPermissions(caller, total),
    };
  }

  #item(series: EventSeries, caller: CallerSession | undefined): EventSeriesListItem {
    return {
      id: series.id,
      slug: series.slug,
      title: series.title,
      description: series.description ?? null,
      descriptionHtml: series.description ? renderMarkdown(series.description).html : null,
      eventCount: this.eventsOf(series, caller).length,
      createdAt: series.createdAt,
      updatedAt: series.updatedAt,
    };
  }
}

export class EventSeriesWriteService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  async create(
    tx: DualStoreTx,
    input: EventSeriesInput,
    session: SessionContext,
  ): Promise<{ series: EventSeries; stateApply: StateApply }> {
    requireAuth('staff', { session });
    const title = this.#validateTitle(input.title);
    const description = this.#validateDescription(input.description ?? null);
    const slug = this.#resolveSlug(input.slug ?? null, title, undefined);
    const now = new Date().toISOString();
    const series: EventSeries = EventSeriesSchema.parse({
      id: uuidv7(),
      slug,
      title,
      description,
      createdAt: now,
      updatedAt: now,
    });
    await tx.public['event-series'].upsert(series);
    return { series, stateApply: new StateApply().upsertEventSeries(series) };
  }

  async update(
    tx: DualStoreTx,
    slug: string,
    input: EventSeriesInput,
    session: SessionContext,
  ): Promise<{ series: EventSeries; stateApply: StateApply }> {
    requireAuth('staff', { session });
    const existing = this.#seriesOrThrow(slug);
    const title = input.title === undefined ? existing.title : this.#validateTitle(input.title);
    const description =
      input.description === undefined ? (existing.description ?? null) : this.#validateDescription(input.description);
    const newSlug =
      input.slug === undefined || input.slug === null || input.slug === existing.slug
        ? existing.slug
        : this.#resolveSlug(input.slug, title, existing.id);

    const updated: EventSeries = EventSeriesSchema.parse({
      ...existing,
      slug: newSlug,
      title,
      description,
      updatedAt: new Date().toISOString(),
    });
    const stateApply = new StateApply();
    if (newSlug !== existing.slug) {
      await tx.public['event-series'].delete(existing);
      const changedAt = new Date();
      const history = {
        id: uuidv7(),
        entityType: 'event_series' as const,
        oldSlug: existing.slug,
        newSlug,
        entityId: existing.id,
        changedAt: changedAt.toISOString(),
        expiresAt: new Date(changedAt.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      };
      await tx.public['slug-history'].upsert(history);
      stateApply.renameEventSeriesSlug(existing.slug).upsertSlugHistory(history);
    }
    await tx.public['event-series'].upsert(updated);
    stateApply.upsertEventSeries(updated);
    return { series: updated, stateApply };
  }

  async delete(tx: DualStoreTx, slug: string, session: SessionContext): Promise<{ stateApply: StateApply }> {
    requireAuth('staff', { session });
    const existing = this.#seriesOrThrow(slug);
    if ((this.#state.eventsBySeries.get(existing.id)?.size ?? 0) > 0) {
      throw new ConflictError('Events still reference this series', 'has_events');
    }
    await tx.public['event-series'].delete(existing);
    return { stateApply: new StateApply().removeEventSeries(existing) };
  }

  #validateTitle(title: string | undefined): string {
    if (!title || title.length < 1 || title.length > 120) {
      throw new ApiValidationError('title required, 1-120 chars', { title: 'required, 1-120 chars' });
    }
    return title;
  }

  #validateDescription(description: string | null): string | null {
    if (description !== null && description.length > 10_000) {
      throw new ApiValidationError('description ≤ 10,000 chars', { description: '≤ 10,000 chars' });
    }
    return description;
  }

  #resolveSlug(explicit: string | null, title: string, selfId: string | undefined): string {
    const taken = (s: string): boolean => {
      const id = this.#state.eventSeriesIdBySlug.get(s);
      return id !== undefined && id !== selfId;
    };
    if (explicit) {
      const slug = explicit.toLowerCase();
      if (!SERIES_SLUG_RE.test(slug)) throw new ApiValidationError('Invalid slug', { slug: 'invalid format' });
      if (isReservedSlug(slug)) throw new ApiValidationError('Slug is reserved', { slug: 'reserved' });
      if (taken(slug)) throw new ConflictError(`Slug '${slug}' is taken`, 'slug_taken');
      return slug;
    }
    const base = slugify(title, 100);
    if (!base) throw new ApiValidationError('Could not derive a slug from the title', { title: 'unusable' });
    return ensureUniqueSlug(base, taken, 100);
  }

  #seriesOrThrow(slug: string): EventSeries {
    const id = this.#state.eventSeriesIdBySlug.get(slug);
    const s = id ? this.#state.eventSeries.get(id) : undefined;
    if (!s) throw new ApiNotFoundError(`Event series '${slug}' not found`);
    return s;
  }
}
