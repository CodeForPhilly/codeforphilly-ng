import type { EventRsvp } from '@/lib/api';

// Attendee grouping — specs/behaviors/events.md#the-follow-up-what-are-you-coming-to-do

export interface AttendeeGroup {
  key: string;
  label: string | null;
  href?: string;
  people: EventRsvp[];
}

/**
 * Projects first (by attendee count, then title), then "New to Code for
 * Philly", "Looking for a project", "Not sure yet" — each only when
 * non-empty. When nobody has answered, one unlabelled group.
 */
export function groupAttendees(rsvps: EventRsvp[]): AttendeeGroup[] {
  if (rsvps.every((r) => r.plan === null)) {
    return rsvps.length ? [{ key: 'all', label: null, people: rsvps }] : [];
  }
  const projects = new Map<string, AttendeeGroup>();
  const newcomers: EventRsvp[] = [];
  const looking: EventRsvp[] = [];
  const unsure: EventRsvp[] = [];
  for (const r of rsvps) {
    if (r.plan === 'project' && r.project) {
      const g = projects.get(r.project.slug) ?? {
        key: `project:${r.project.slug}`,
        label: r.project.title,
        href: `/projects/${r.project.slug}`,
        people: [],
      };
      g.people.push(r);
      projects.set(r.project.slug, g);
    } else if (r.plan === 'newcomer') newcomers.push(r);
    else if (r.plan === 'no_project') looking.push(r);
    else unsure.push(r);
  }
  const groups = [...projects.values()].sort(
    (a, b) => b.people.length - a.people.length || (a.label ?? '').localeCompare(b.label ?? ''),
  );
  if (newcomers.length) groups.push({ key: 'newcomer', label: 'New to Code for Philly', people: newcomers });
  if (looking.length) groups.push({ key: 'no_project', label: 'Looking for a project', people: looking });
  if (unsure.length) groups.push({ key: 'unsure', label: 'Not sure yet', people: unsure });
  return groups;
}
