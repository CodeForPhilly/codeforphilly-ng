/**
 * Event reminder sweep — specs/behaviors/events.md#reminders.
 *
 * Every five minutes, find scheduled events whose one-week or one-day
 * reminder is due, record the send on the event record FIRST (one commit
 * under the store's writer), then email each going attendee. At-most-once:
 * a send failure is logged and never retried; a duplicate reminder is the
 * worse failure.
 */
import { EventSchema, type Event } from '@cfp/shared/schemas';
import type { FastifyBaseLogger } from 'fastify';

import type { Notifier } from '../notify/index.js';
import type { FtsEngine } from '../store/fts.js';
import type { InMemoryState } from '../store/memory/state.js';
import type { PrivateStore } from '../store/private/interface.js';
import { StateApply } from '../store/state-apply.js';
import type { Store } from '../store/store.js';
import { eventEmailFacts, rsvpPlanLine } from './event-notify.js';
import { EventService } from './event.js';

export type ReminderKind = 'week' | 'day';

export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Which reminder, if any, is due for an event at `now`. Each reminder is due
 * only in a band just after its mark — week: [start−7d, start−6d), day:
 * [start−24h, start−18h) — and only while unsent. Outside the band the
 * reminder is skipped, never sent late.
 */
export function dueReminder(event: Event, now: Date): ReminderKind | null {
  if (event.status !== 'scheduled') return null;
  const start = new Date(event.startsAt).getTime();
  const t = now.getTime();
  if (t >= start - 7 * DAY && t < start - 6 * DAY && !event.reminders?.weekSentAt) return 'week';
  if (t >= start - 24 * HOUR && t < start - 18 * HOUR && !event.reminders?.daySentAt) return 'day';
  return null;
}

export interface EventReminderDeps {
  readonly state: InMemoryState;
  readonly fts: FtsEngine;
  readonly store: Store;
  readonly privateStore: PrivateStore;
  readonly notifier: Notifier;
  readonly siteHost: string;
  readonly log: FastifyBaseLogger;
}

export class EventReminderService {
  readonly #d: EventReminderDeps;
  readonly #events: EventService;

  constructor(deps: EventReminderDeps) {
    this.#d = deps;
    this.#events = new EventService(deps.state);
  }

  /** One pass. Returns how many events were marked and how many emails were attempted. */
  async sweep(now: Date = new Date()): Promise<{ events: number; sent: number }> {
    let events = 0;
    let sent = 0;
    // Snapshot first: marking mutates the state Map while we iterate.
    const due = [...this.#d.state.events.values()]
      .map((event) => ({ event, kind: dueReminder(event, now) }))
      .filter((x): x is { event: Event; kind: ReminderKind } => x.kind !== null);

    for (const { event, kind } of due) {
      const marked = await this.#mark(event, kind, now);
      events += 1;
      sent += await this.#send(marked, kind);
    }
    return { events, sent };
  }

  /** Record `reminders.<kind>SentAt` in its own commit before any mail goes out. */
  async #mark(event: Event, kind: ReminderKind, now: Date): Promise<Event> {
    const marked: Event = EventSchema.parse({
      ...event,
      reminders: { ...(event.reminders ?? {}), [`${kind}SentAt`]: now.toISOString() },
    });
    await this.#d.store.transact(
      {
        message: `events: mark ${kind} reminder sent for ${event.slug}`,
        author: { name: 'cfp-api', email: 'api@codeforphilly.org' },
      },
      async (tx) => {
        await tx.public.events.upsert(marked);
      },
    );
    new StateApply().upsertEvent(marked).apply(this.#d.state, this.#d.fts);
    return marked;
  }

  async #send(event: Event, kind: ReminderKind): Promise<number> {
    const facts = eventEmailFacts(event, this.#d.siteHost);
    let attempted = 0;
    for (const rsvp of this.#events.rsvpsFor(event.id)) {
      const person = this.#d.state.people.get(rsvp.personId);
      if (!person || person.deletedAt) continue;
      const profile = await this.#d.privateStore.getProfile(person.id);
      if (!profile?.email) {
        this.#d.log.info({ event: event.slug, person: person.slug }, 'event reminder: no email; skipped');
        continue;
      }
      attempted += 1;
      try {
        await this.#d.notifier.notifyEventReminder({
          email: profile.email,
          fullName: person.fullName,
          kind,
          event: facts,
          planLine: rsvpPlanLine(rsvp, (id) => this.#d.state.projects.get(id)),
        });
      } catch (err) {
        this.#d.log.error({ err, event: event.slug, person: person.slug }, 'event reminder: send threw');
      }
    }
    return attempted;
  }
}
