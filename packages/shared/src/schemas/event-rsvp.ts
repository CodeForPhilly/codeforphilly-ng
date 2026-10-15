import { z } from 'zod';

import { references } from '../references.js';

export const EVENT_RSVP_PLANS = ['newcomer', 'no_project', 'project'] as const;
export type EventRsvpPlan = (typeof EVENT_RSVP_PLANS)[number];

/**
 * A member's public "I'm going". Existence means going; there is no status.
 * `plan` is the optional follow-up answer ("what are you coming to do?") and
 * `projectId` is set only when `plan = project`.
 *
 * Keyed on disk by `event-rsvps/${year}/${eventSlug}/${personSlug}`; all
 * three are fields of the record. `year` is the event's partition year (the
 * `YYYY` of its `startsAt`, the same rule as the event's own path) and moves
 * with the event (specs/data-model.md#eventrsvp).
 */
export const EventRsvpSchema = z.object({
  id: z.string().uuid(),
  year: z.string().regex(/^\d{4}$/),
  eventSlug: z.string().min(1).meta(references('events.slug')),
  personSlug: z.string().min(1).meta(references('people.slug')),
  plan: z.enum(EVENT_RSVP_PLANS).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type EventRsvp = z.infer<typeof EventRsvpSchema>;
