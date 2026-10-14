import { z } from 'zod';

/**
 * A named, open-ended grouping of events — "Monthly Hack Nights",
 * "Launchpad". No dates of its own, no RSVPs; a label with a page
 * (specs/data-model.md#eventseries-new). Never a generator: every
 * occurrence is still its own Event record.
 */
export const EventSeriesSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  title: z.string().min(1).max(120),
  description: z.string().max(10_000).nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

export type EventSeries = z.infer<typeof EventSeriesSchema>;
