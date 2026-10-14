/**
 * EventService — read operations for events and RSVPs.
 *
 * Everything is served from the in-memory state. The event corpus is tiny
 * (roughly one a month), so "upcoming" and "past" are a filter + sort over
 * `state.events.values()` rather than a maintained sorted index.
 */
import type { Event, EventRsvp } from '@cfp/shared/schemas';

import type { InMemoryState } from '../store/memory/state.js';
import { rsvpKey } from '../store/memory/state.js';
import { computeEventPermissions, type CallerSession } from './permissions.js';
import {
  serializeEvent,
  serializeEventRsvp,
  serializeEventSummary,
  type EventResponse,
  type EventRsvpResponse,
  type EventSummaryResponse,
  type ProjectRef,
} from './serializers/event.js';

export type EventWhen = 'upcoming' | 'past' | 'all';

export interface EventListOptions {
  readonly when?: string;
  readonly sort?: string;
  readonly page?: number;
  readonly perPage?: number;
  readonly now?: Date;
}

export interface EventRsvpListOptions {
  readonly page?: number;
  readonly perPage?: number;
}

function isStaff(caller: CallerSession | undefined): boolean {
  return caller?.accountLevel === 'staff' || caller?.accountLevel === 'administrator';
}

/** Upcoming while `endsAt > now`; past once `endsAt ≤ now` (specs/behaviors/events.md#upcoming-vs-past). */
export function isUpcoming(event: Pick<Event, 'endsAt'>, now: Date): boolean {
  return new Date(event.endsAt) > now;
}

export class EventService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  // ---------------------------------------------------------------------------
  // raw lookups (shared with routes + write service)
  // ---------------------------------------------------------------------------

  /** The raw record, or undefined. Drafts are returned — callers gate visibility. */
  findBySlug(slug: string): Event | undefined {
    const id = this.#state.eventIdBySlug.get(slug);
    return id ? this.#state.events.get(id) : undefined;
  }

  /** The record a given caller is allowed to see, or undefined (draft + non-staff → hidden). */
  findVisible(slug: string, caller: CallerSession | undefined): Event | undefined {
    const event = this.findBySlug(slug);
    if (!event) return undefined;
    if (event.status === 'draft' && !isStaff(caller)) return undefined;
    return event;
  }

  rsvpCount(eventId: string): number {
    return this.#state.rsvpsByEvent.get(eventId)?.size ?? 0;
  }

  viewerRsvp(eventId: string, caller: CallerSession | undefined): EventRsvp | null {
    if (!caller) return null;
    const id = this.#state.rsvpIdByEventAndPerson.get(rsvpKey(eventId, caller.id));
    return id ? (this.#state.eventRsvps.get(id) ?? null) : null;
  }

  /**
   * Projects the caller named on their RSVPs to other events, most recently
   * answered first, de-duplicated, at most eight — the follow-up picker's
   * first suggestions (specs/api/events.md#get-apieventsslug).
   */
  viewerRecentProjects(eventId: string, caller: CallerSession | undefined): ProjectRef[] {
    if (!caller) return [];
    const ids = this.#state.rsvpsByPerson.get(caller.id) ?? new Set<string>();
    const named = [...ids]
      .map((id) => this.#state.eventRsvps.get(id))
      .filter((r): r is EventRsvp => r !== undefined && r.eventId !== eventId && r.plan === 'project' && !!r.projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const out: ProjectRef[] = [];
    const seen = new Set<string>();
    for (const r of named) {
      const p = this.#state.projects.get(r.projectId!);
      if (!p || p.deletedAt || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ slug: p.slug, title: p.title });
      if (out.length === 8) break;
    }
    return out;
  }

  /** Going RSVPs for an event, oldest first. */
  rsvpsFor(eventId: string): EventRsvp[] {
    const ids = this.#state.rsvpsByEvent.get(eventId) ?? new Set<string>();
    const rsvps = [...ids]
      .map((id) => this.#state.eventRsvps.get(id))
      .filter((r): r is EventRsvp => r !== undefined);
    rsvps.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return rsvps;
  }

  /** Events eligible for the subscription feed: scheduled or cancelled, ending within the trailing 90 days or later. */
  feedEvents(now: Date = new Date()): Event[] {
    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const events = [...this.#state.events.values()].filter(
      (e) => e.status !== 'draft' && new Date(e.endsAt) >= cutoff,
    );
    events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return events;
  }

  // ---------------------------------------------------------------------------
  // serialized reads
  // ---------------------------------------------------------------------------

  /** `{ slug, title }` of the event's series, or null. */
  seriesRef(event: Event): { slug: string; title: string } | null {
    if (!event.seriesId) return null;
    const s = this.#state.eventSeries.get(event.seriesId);
    return s ? { slug: s.slug, title: s.title } : null;
  }

  serialize(event: Event, caller: CallerSession | undefined, now: Date = new Date()): EventResponse {
    const rsvpCount = this.rsvpCount(event.id);
    return serializeEvent(event, {
      rsvpCount,
      viewerRsvp: this.viewerRsvp(event.id, caller),
      viewerRecentProjects: this.viewerRecentProjects(event.id, caller),
      projectLookup: (id) => this.#state.projects.get(id),
      series: this.seriesRef(event),
      permissions: computeEventPermissions(caller, event, rsvpCount, now),
    });
  }

  serializeSummary(event: Event, caller: CallerSession | undefined): EventSummaryResponse {
    return serializeEventSummary(event, {
      rsvpCount: this.rsvpCount(event.id),
      viewerRsvp: this.viewerRsvp(event.id, caller),
      projectLookup: (id) => this.#state.projects.get(id),
      series: this.seriesRef(event),
    });
  }

  list(
    opts: EventListOptions,
    caller?: CallerSession,
  ): { items: EventSummaryResponse[]; totalItems: number } | { error: 'invalid_when' | 'invalid_sort' } {
    const when = (opts.when ?? 'upcoming') as EventWhen;
    if (when !== 'upcoming' && when !== 'past' && when !== 'all') return { error: 'invalid_when' };

    const defaultSort = when === 'past' ? '-startsAt' : 'startsAt';
    const sort = opts.sort ?? defaultSort;
    if (sort !== 'startsAt' && sort !== '-startsAt') return { error: 'invalid_sort' };
    const desc = sort.startsWith('-');

    const now = opts.now ?? new Date();
    const staff = isStaff(caller);
    const events = [...this.#state.events.values()].filter((e) => {
      if (e.status === 'draft' && !staff) return false;
      if (when === 'upcoming') return isUpcoming(e, now);
      if (when === 'past') return !isUpcoming(e, now);
      return true;
    });
    events.sort((a, b) => {
      const cmp = a.startsAt.localeCompare(b.startsAt) || a.slug.localeCompare(b.slug);
      return desc ? -cmp : cmp;
    });

    const totalItems = events.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));
    const slice = events.slice((page - 1) * perPage, page * perPage);
    return { items: slice.map((e) => this.serializeSummary(e, caller)), totalItems };
  }

  get(slug: string, caller?: CallerSession, now: Date = new Date()): EventResponse | null {
    const event = this.findVisible(slug, caller);
    if (!event) return null;
    return this.serialize(event, caller, now);
  }

  listRsvps(
    slug: string,
    opts: EventRsvpListOptions,
    caller?: CallerSession,
  ): { items: EventRsvpResponse[]; totalItems: number } | null {
    const event = this.findVisible(slug, caller);
    if (!event) return null;
    const rsvps = this.rsvpsFor(event.id);
    const totalItems = rsvps.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 100));
    const slice = rsvps.slice((page - 1) * perPage, page * perPage);
    const items = slice.map((r) =>
      serializeEventRsvp(r, this.#state.people.get(r.personId), (id) => this.#state.projects.get(id)),
    );
    return { items, totalItems };
  }
}
