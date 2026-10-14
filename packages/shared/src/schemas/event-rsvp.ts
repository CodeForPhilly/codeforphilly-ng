import { z } from 'zod';

export const EVENT_RSVP_PLANS = ['newcomer', 'no_project', 'project'] as const;
export type EventRsvpPlan = (typeof EVENT_RSVP_PLANS)[number];

/**
 * A member's public "I'm going". Existence means going; there is no status.
 * `plan` is the optional follow-up answer ("what are you coming to do?") and
 * `projectId` is set only when `plan = project`.
 *
 * `passthrough()` so the denormalized path-template fields (eventSlug,
 * personSlug) supplied by the write service survive validation and reach
 * gitsheets' path template renderer per specs/behaviors/storage.md#sheet-layout.
 */
export const EventRsvpSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  personId: z.string().uuid(),
  plan: z.enum(EVENT_RSVP_PLANS).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

export type EventRsvp = z.infer<typeof EventRsvpSchema>;
