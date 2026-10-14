/**
 * Shared helpers for event emails: the facts every event mail shows and the
 * attendee fan-out. Used by the routes (RSVP confirmation, updated,
 * cancelled) and the reminder sweep.
 */
import type { Event, EventRsvp, Person, Project } from '@cfp/shared/schemas';

import { formatEventWhen } from '../lib/event-time.js';
import { eventUrl } from '../lib/ics.js';
import type { EventEmailFacts } from '../notify/index.js';
import type { InMemoryState } from '../store/memory/state.js';
import type { PrivateStore } from '../store/private/interface.js';

export function eventEmailFacts(event: Event, siteHost: string): EventEmailFacts {
  return {
    slug: event.slug,
    title: event.title,
    when: formatEventWhen(event.startsAt, event.endsAt),
    venueName: event.venueName ?? null,
    venueAddress: event.venueAddress ?? null,
    onlineUrl: event.onlineUrl ?? null,
    url: eventUrl(siteHost, event.slug),
  };
}

/** The follow-up answer as a sentence for emails, or null when unanswered. */
export function rsvpPlanLine(rsvp: EventRsvp, lookup: (id: string) => Project | undefined): string | null {
  switch (rsvp.plan) {
    case 'newcomer':
      return "You said you're new to Code for Philly — we'll have someone say hi.";
    case 'no_project':
      return "You said you don't have a project yet — come find one at the door.";
    case 'project': {
      const p = rsvp.projectId ? lookup(rsvp.projectId) : undefined;
      return p ? `You said you're coming to work on ${p.title}.` : null;
    }
    default:
      return null;
  }
}

export interface Attendee {
  readonly email: string;
  readonly fullName: string;
  readonly person: Person;
  readonly rsvp: EventRsvp;
}

/** Every going attendee with a deliverable address. Skips deactivated people and missing emails. */
export async function collectAttendees(
  state: InMemoryState,
  privateStore: PrivateStore,
  rsvps: readonly EventRsvp[],
): Promise<Attendee[]> {
  const out: Attendee[] = [];
  for (const rsvp of rsvps) {
    const person = state.people.get(rsvp.personId);
    if (!person || person.deletedAt) continue;
    const profile = await privateStore.getProfile(person.id);
    if (!profile?.email) continue;
    out.push({ email: profile.email, fullName: person.fullName, person, rsvp });
  }
  return out;
}
