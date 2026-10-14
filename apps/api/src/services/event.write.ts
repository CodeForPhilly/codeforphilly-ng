/**
 * Event writes — specs/api/events.md:
 *  - POST   /api/events                 (staff)
 *  - PATCH  /api/events/:slug           (staff)
 *  - POST   /api/events/:slug/publish   (staff)
 *  - POST   /api/events/:slug/cancel    (staff)
 *  - DELETE /api/events/:slug           (staff)
 *  - PUT    /api/events/:slug/rsvp      (user)
 *  - DELETE /api/events/:slug/rsvp      (user)
 *
 * Email side effects are not here: the services return what changed and
 * the route fires the notifier after the commit, fire-and-forget
 * (specs/behaviors/events.md → "The write never waits on the mail").
 */
import { uuidv7 } from 'uuidv7';
import {
  EventRsvpSchema,
  EventSchema,
  EVENT_RSVP_PLANS,
  type Event,
  type EventAgendaItem,
  type EventRsvp,
  type EventRsvpPlan,
  type Project,
} from '@cfp/shared/schemas';

import type { SessionContext } from '../auth/middleware.js';
import { requireAuth } from '../auth/require.js';
import { ApiNotFoundError, ApiValidationError, ConflictError } from '../lib/errors.js';
import { nyDateString } from '../lib/event-time.js';
import { ensureUniqueSlug, isReservedSlug, isValidEventSlug, slugify } from '../lib/slug.js';
import type { InMemoryState } from '../store/memory/state.js';
import { rsvpKey } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import type { DualStoreTx } from '../store/store.js';
import { isRsvpOpen } from './permissions.js';

function nowIso(): string {
  return new Date().toISOString();
}

/** Denormalized path-template fields for `event-rsvps/${eventSlug}/${personSlug}`. */
function withRsvpPath(rsvp: EventRsvp, eventSlug: string, personSlug: string): EventRsvp {
  return { ...rsvp, eventSlug, personSlug } as EventRsvp;
}

/** Fields whose change bumps `icsSequence` (specs/behaviors/events.md#calendar-files). */
const CALENDAR_FIELDS = ['title', 'startsAt', 'endsAt', 'venueName', 'venueAddress', 'onlineUrl'] as const;
/** Subset that also emails attendees ("event updated"). */
const TIME_OR_PLACE_FIELDS = ['startsAt', 'endsAt', 'venueName', 'venueAddress', 'onlineUrl'] as const;

export interface EventInput {
  title?: string;
  slug?: string | null;
  description?: string | null;
  startsAt?: string;
  endsAt?: string;
  venueName?: string | null;
  venueAddress?: string | null;
  onlineUrl?: string | null;
  meetupUrl?: string | null;
  agenda?: EventAgendaItem[] | null;
  status?: string;
}

export interface EventChange {
  readonly field: (typeof TIME_OR_PLACE_FIELDS)[number];
  readonly from: string | null;
  readonly to: string | null;
}

export interface RsvpInput {
  plan?: string | null;
  projectSlug?: string | null;
}

function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && !Number.isNaN(new Date(s).getTime());
}

function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

function isMeetupUrl(s: string): boolean {
  try {
    const host = new URL(s).hostname;
    return host === 'meetup.com' || host.endsWith('.meetup.com');
  } catch {
    return false;
  }
}

export class EventWriteService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  // ---------------------------------------------------------------------------
  // staff: event lifecycle
  // ---------------------------------------------------------------------------

  async create(
    tx: DualStoreTx,
    input: EventInput,
    session: SessionContext,
  ): Promise<{ event: Event; stateApply: StateApply }> {
    requireAuth('staff', { session });

    const fields: Record<string, string> = {};
    if (!input.title || input.title.length < 1 || input.title.length > 200) fields['title'] = 'required, 1-200 chars';
    if (!isIsoDate(input.startsAt)) fields['startsAt'] = 'required ISO 8601 datetime';
    if (!isIsoDate(input.endsAt)) fields['endsAt'] = 'required ISO 8601 datetime';
    if (Object.keys(fields).length > 0) throw new ApiValidationError('Invalid event', fields);

    const base = this.#validateCommon(
      {
        title: input.title!,
        description: input.description ?? null,
        startsAt: new Date(input.startsAt!).toISOString(),
        endsAt: new Date(input.endsAt!).toISOString(),
        venueName: input.venueName ?? null,
        venueAddress: input.venueAddress ?? null,
        onlineUrl: input.onlineUrl ?? null,
        meetupUrl: input.meetupUrl ?? null,
        agenda: input.agenda ?? [],
      },
    );

    const status = input.status ?? 'scheduled';
    if (status !== 'draft' && status !== 'scheduled') {
      throw new ApiValidationError('status must be draft or scheduled', { status: 'invalid' });
    }

    const slug = this.#resolveSlug(input.slug ?? null, base.title, base.startsAt, undefined);

    const now = nowIso();
    const event: Event = EventSchema.parse({
      id: uuidv7(),
      slug,
      ...base,
      status,
      icsSequence: 0,
      createdById: session.person?.id ?? null,
      createdAt: now,
      updatedAt: now,
    });

    await tx.public.events.upsert(event);
    return { event, stateApply: new StateApply().upsertEvent(event) };
  }

  async update(
    tx: DualStoreTx,
    slug: string,
    input: EventInput,
    session: SessionContext,
  ): Promise<{ event: Event; previous: Event; changes: EventChange[]; stateApply: StateApply }> {
    requireAuth('staff', { session });
    const existing = this.#eventOrThrow(slug);
    if (input.status !== undefined) {
      throw new ApiValidationError('status is not editable here; use publish or cancel', { status: 'readonly' });
    }

    const fields: Record<string, string> = {};
    if (input.title !== undefined && (input.title.length < 1 || input.title.length > 200)) fields['title'] = '1-200 chars';
    if (input.startsAt !== undefined && !isIsoDate(input.startsAt)) fields['startsAt'] = 'ISO 8601 datetime';
    if (input.endsAt !== undefined && !isIsoDate(input.endsAt)) fields['endsAt'] = 'ISO 8601 datetime';
    if (Object.keys(fields).length > 0) throw new ApiValidationError('Invalid event', fields);

    const base = this.#validateCommon({
      title: input.title ?? existing.title,
      description: input.description === undefined ? (existing.description ?? null) : input.description,
      startsAt: input.startsAt === undefined ? existing.startsAt : new Date(input.startsAt).toISOString(),
      endsAt: input.endsAt === undefined ? existing.endsAt : new Date(input.endsAt).toISOString(),
      venueName: input.venueName === undefined ? (existing.venueName ?? null) : input.venueName,
      venueAddress: input.venueAddress === undefined ? (existing.venueAddress ?? null) : input.venueAddress,
      onlineUrl: input.onlineUrl === undefined ? (existing.onlineUrl ?? null) : input.onlineUrl,
      meetupUrl: input.meetupUrl === undefined ? (existing.meetupUrl ?? null) : input.meetupUrl,
      agenda: input.agenda === undefined ? (existing.agenda ?? []) : (input.agenda ?? []),
    });

    const newSlug =
      input.slug === undefined || input.slug === null || input.slug === existing.slug
        ? existing.slug
        : this.#resolveSlug(input.slug, base.title, base.startsAt, existing.id);
    const slugChanged = newSlug !== existing.slug;

    const calendarChanged = CALENDAR_FIELDS.some((f) => (existing[f] ?? null) !== (base[f] ?? null));
    const changes: EventChange[] = TIME_OR_PLACE_FIELDS.filter(
      (f) => (existing[f] ?? null) !== (base[f] ?? null),
    ).map((f) => ({ field: f, from: existing[f] ?? null, to: base[f] ?? null }));

    const updated: Event = EventSchema.parse({
      ...existing,
      ...base,
      slug: newSlug,
      icsSequence: (existing.icsSequence ?? 0) + (calendarChanged ? 1 : 0),
      updatedAt: nowIso(),
    });

    const stateApply = new StateApply();

    if (slugChanged) {
      // Delete the old file, write slug history, and move every RSVP file
      // under the new event slug in this same commit
      // (specs/api/events.md#patch-apieventsslug).
      await tx.public.events.delete(existing);
      const changedAt = nowIso();
      const history = {
        id: uuidv7(),
        entityType: 'event' as const,
        oldSlug: existing.slug,
        newSlug,
        entityId: existing.id,
        changedAt,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      };
      await tx.public['slug-history'].upsert(history);
      stateApply.renameEventSlug(existing.slug).upsertSlugHistory(history);

      for (const rsvpId of this.#state.rsvpsByEvent.get(existing.id) ?? new Set<string>()) {
        const rsvp = this.#state.eventRsvps.get(rsvpId);
        if (!rsvp) continue;
        const personSlug = this.#state.personSlugById.get(rsvp.personId);
        if (!personSlug) continue;
        await tx.public['event-rsvps'].delete(withRsvpPath(rsvp, existing.slug, personSlug));
        await tx.public['event-rsvps'].upsert(withRsvpPath(rsvp, newSlug, personSlug));
      }
    }

    await tx.public.events.upsert(updated);
    stateApply.upsertEvent(updated);
    return { event: updated, previous: existing, changes, stateApply };
  }

  async publish(tx: DualStoreTx, slug: string, session: SessionContext): Promise<{ event: Event; stateApply: StateApply }> {
    requireAuth('staff', { session });
    const existing = this.#eventOrThrow(slug);
    if (existing.status !== 'draft') throw new ConflictError('Event is not a draft', 'not_draft');
    const updated: Event = EventSchema.parse({ ...existing, status: 'scheduled', updatedAt: nowIso() });
    await tx.public.events.upsert(updated);
    return { event: updated, stateApply: new StateApply().upsertEvent(updated) };
  }

  async cancel(
    tx: DualStoreTx,
    slug: string,
    input: { note?: string | null },
    session: SessionContext,
  ): Promise<{ event: Event; stateApply: StateApply }> {
    requireAuth('staff', { session });
    const existing = this.#eventOrThrow(slug);
    if (existing.status !== 'scheduled') throw new ConflictError('Event is not scheduled', 'not_scheduled');
    const note = input.note ?? null;
    if (note !== null && note.length > 500) throw new ApiValidationError('note ≤ 500 chars', { note: 'too long' });
    const now = nowIso();
    const updated: Event = EventSchema.parse({
      ...existing,
      status: 'cancelled',
      cancelledAt: now,
      cancellationNote: note,
      icsSequence: (existing.icsSequence ?? 0) + 1,
      updatedAt: now,
    });
    await tx.public.events.upsert(updated);
    return { event: updated, stateApply: new StateApply().upsertEvent(updated) };
  }

  async delete(tx: DualStoreTx, slug: string, session: SessionContext): Promise<{ stateApply: StateApply }> {
    requireAuth('staff', { session });
    const existing = this.#eventOrThrow(slug);
    const rsvpIds = this.#state.rsvpsByEvent.get(existing.id) ?? new Set<string>();
    if (existing.status !== 'draft' && rsvpIds.size > 0) {
      throw new ConflictError('Event has RSVPs — cancel it instead', 'has_rsvps');
    }
    const stateApply = new StateApply();
    for (const rsvpId of rsvpIds) {
      const rsvp = this.#state.eventRsvps.get(rsvpId);
      if (!rsvp) continue;
      const personSlug = this.#state.personSlugById.get(rsvp.personId);
      if (!personSlug) continue;
      await tx.public['event-rsvps'].delete(withRsvpPath(rsvp, existing.slug, personSlug));
      stateApply.removeEventRsvp(rsvp);
    }
    await tx.public.events.delete(existing);
    stateApply.removeEvent(existing);
    return { stateApply };
  }

  // ---------------------------------------------------------------------------
  // members: RSVP
  // ---------------------------------------------------------------------------

  async putRsvp(
    tx: DualStoreTx,
    slug: string,
    input: RsvpInput,
    session: SessionContext,
  ): Promise<{ event: Event; rsvp: EventRsvp; created: boolean; stateApply: StateApply }> {
    requireAuth('user', { session });
    const person = session.person!;
    const event = this.#eventOrThrow(slug, session);
    if (!isRsvpOpen(event)) throw new ConflictError('RSVPs are closed for this event', 'rsvp_closed');

    const existingId = this.#state.rsvpIdByEventAndPerson.get(rsvpKey(event.id, person.id));
    const existing = existingId ? this.#state.eventRsvps.get(existingId) : undefined;

    let plan: EventRsvpPlan | null = existing?.plan ?? null;
    let projectId: string | null = existing?.projectId ?? null;
    if (input.plan !== undefined) {
      if (input.plan === null) {
        plan = null;
        projectId = null;
      } else if ((EVENT_RSVP_PLANS as readonly string[]).includes(input.plan)) {
        plan = input.plan as EventRsvpPlan;
        if (plan === 'project') {
          if (!input.projectSlug) {
            throw new ApiValidationError('projectSlug is required when plan is project', { projectSlug: 'required' });
          }
          projectId = this.#projectOrThrow(input.projectSlug).id;
        } else {
          projectId = null;
        }
      } else {
        throw new ApiValidationError('Unknown plan', { plan: 'must be newcomer, no_project, or project' });
      }
    } else if (input.projectSlug !== undefined && input.projectSlug !== null && plan === 'project') {
      // Project changed without restating the plan.
      projectId = this.#projectOrThrow(input.projectSlug).id;
    }

    const now = nowIso();
    const rsvp: EventRsvp = EventRsvpSchema.parse({
      id: existing?.id ?? uuidv7(),
      eventId: event.id,
      personId: person.id,
      plan,
      projectId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await tx.public['event-rsvps'].upsert(withRsvpPath(rsvp, event.slug, person.slug));
    return { event, rsvp, created: existing === undefined, stateApply: new StateApply().upsertEventRsvp(rsvp) };
  }

  async deleteRsvp(
    tx: DualStoreTx,
    slug: string,
    session: SessionContext,
  ): Promise<{ removed: boolean; stateApply: StateApply }> {
    requireAuth('user', { session });
    const person = session.person!;
    const event = this.#eventOrThrow(slug, session);
    if (new Date(event.endsAt) <= new Date()) {
      throw new ConflictError('The event has ended; the attendance record is history now', 'rsvp_closed');
    }
    const existingId = this.#state.rsvpIdByEventAndPerson.get(rsvpKey(event.id, person.id));
    const existing = existingId ? this.#state.eventRsvps.get(existingId) : undefined;
    if (!existing) return { removed: false, stateApply: new StateApply() };
    await tx.public['event-rsvps'].delete(withRsvpPath(existing, event.slug, person.slug));
    return { removed: true, stateApply: new StateApply().removeEventRsvp(existing) };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  #validateCommon(v: {
    title: string;
    description: string | null;
    startsAt: string;
    endsAt: string;
    venueName: string | null;
    venueAddress: string | null;
    onlineUrl: string | null;
    meetupUrl: string | null;
    agenda: EventAgendaItem[];
  }): typeof v {
    const fields: Record<string, string> = {};
    if (new Date(v.endsAt) <= new Date(v.startsAt)) fields['endsAt'] = 'must be after startsAt';
    if (v.description !== null && v.description.length > 20_000) fields['description'] = '≤ 20,000 chars';
    if (v.venueName !== null && v.venueName.length > 120) fields['venueName'] = '≤ 120 chars';
    if (v.venueAddress !== null && v.venueAddress.length > 300) fields['venueAddress'] = '≤ 300 chars';
    if (v.onlineUrl !== null && !isHttpsUrl(v.onlineUrl)) fields['onlineUrl'] = 'must be an https URL';
    if (v.meetupUrl !== null && (!isHttpsUrl(v.meetupUrl) || !isMeetupUrl(v.meetupUrl))) {
      fields['meetupUrl'] = 'must be an https meetup.com URL';
    }
    if (v.agenda.length > 50) fields['agenda'] = '≤ 50 items';
    const start = new Date(v.startsAt).getTime();
    const end = new Date(v.endsAt).getTime();
    v.agenda.forEach((item, i) => {
      if (!isIsoDate(item.startsAt)) { fields[`agenda.${i}.startsAt`] = 'ISO 8601 datetime'; return; }
      const s = new Date(item.startsAt).getTime();
      if (s < start || s > end) fields[`agenda.${i}.startsAt`] = "must be within the event's range";
      if (item.endsAt && new Date(item.endsAt).getTime() <= s) fields[`agenda.${i}.endsAt`] = 'must be after startsAt';
      if (!item.title || item.title.length > 120) fields[`agenda.${i}.title`] = 'required, 1-120 chars';
    });
    if (Object.keys(fields).length > 0) throw new ApiValidationError('Invalid event', fields);

    const agenda = [...v.agenda]
      .map((item) => ({
        startsAt: new Date(item.startsAt).toISOString(),
        endsAt: item.endsAt ? new Date(item.endsAt).toISOString() : null,
        title: item.title,
        venueName: item.venueName ?? null,
        venueAddress: item.venueAddress ?? null,
        description: item.description ?? null,
      }))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return { ...v, agenda };
  }

  /** Validate an explicit slug or derive `<YYYY-MM-DD>-<title>` and de-duplicate. */
  #resolveSlug(explicit: string | null, title: string, startsAt: string, selfId: string | undefined): string {
    const taken = (s: string): boolean => {
      const id = this.#state.eventIdBySlug.get(s);
      return id !== undefined && id !== selfId;
    };
    if (explicit) {
      const slug = explicit.toLowerCase();
      if (!isValidEventSlug(slug)) throw new ApiValidationError('Invalid slug', { slug: 'invalid format' });
      if (isReservedSlug(slug)) {
        const err = new ApiValidationError('Slug is reserved', { slug: 'reserved' });
        (err as { code?: string }).code = 'slug_reserved';
        throw err;
      }
      if (taken(slug)) throw new ConflictError(`Slug '${slug}' is taken`, 'slug_taken');
      return slug;
    }
    const base = `${nyDateString(startsAt)}-${slugify(title, 80)}`.replace(/-+$/, '');
    return ensureUniqueSlug(base, taken, 100);
  }

  #eventOrThrow(slug: string, session?: SessionContext): Event {
    const id = this.#state.eventIdBySlug.get(slug);
    const event = id ? this.#state.events.get(id) : undefined;
    if (!event) throw new ApiNotFoundError(`Event '${slug}' not found`);
    if (session && event.status === 'draft') {
      const level = session.person?.accountLevel;
      if (level !== 'staff' && level !== 'administrator') throw new ApiNotFoundError(`Event '${slug}' not found`);
    }
    return event;
  }

  #projectOrThrow(slug: string): Project {
    const id = this.#state.projectIdBySlug.get(slug);
    const p = id ? this.#state.projects.get(id) : undefined;
    if (!p || p.deletedAt) throw new ApiNotFoundError(`Project '${slug}' not found`);
    return p;
  }
}
