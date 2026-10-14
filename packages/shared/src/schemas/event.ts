import { z } from 'zod';

/**
 * One timed line in an event's schedule — laddr's `EventSegment`, embedded
 * in the event record rather than stored separately. No id, no slug, no
 * RSVPs. See specs/data-model.md#agenda-items.
 */
export const EventAgendaItemSchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  title: z.string().min(1).max(120),
  venueName: z.string().max(120).nullable().optional(),
  venueAddress: z.string().max(300).nullable().optional(),
  description: z.string().max(2_000).nullable().optional(),
});

export type EventAgendaItem = z.infer<typeof EventAgendaItemSchema>;

export const EVENT_STATUSES = ['draft', 'scheduled', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * A single dated gathering: hack night, workshop, showcase. Flat — one
 * record is one thing a member can RSVP to. `seriesId` and `agenda` are
 * the two optional structures that hang off it (specs/behaviors/events.md).
 *
 * `passthrough()` is not needed here (the path template is `${slug}`, a
 * real field) but kept for symmetry with the other sheets so a future
 * denormalized path field doesn't need a schema change.
 */
export const EventSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  slug: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).nullable().optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  venueName: z.string().max(120).nullable().optional(),
  venueAddress: z.string().max(300).nullable().optional(),
  onlineUrl: z.string().url().nullable().optional(),
  meetupUrl: z.string().url().nullable().optional(),
  seriesId: z.string().uuid().nullable().optional(),
  agenda: z.array(EventAgendaItemSchema).max(50).optional(),
  status: z.enum(EVENT_STATUSES),
  cancelledAt: z.string().datetime({ offset: true }).nullable().optional(),
  cancellationNote: z.string().max(500).nullable().optional(),
  /** iCalendar SEQUENCE — bumped on every calendar-relevant change and on cancel. */
  icsSequence: z.number().int().nonnegative().default(0),
  /** At-most-once bookkeeping for the reminder sweep. */
  reminders: z
    .object({
      weekSentAt: z.string().datetime({ offset: true }).optional(),
      daySentAt: z.string().datetime({ offset: true }).optional(),
    })
    .optional(),
  createdById: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

export type Event = z.infer<typeof EventSchema>;
