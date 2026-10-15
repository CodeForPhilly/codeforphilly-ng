import type { EventRsvp } from '@/lib/api';

// Attendee grouping — specs/behaviors/events.md#the-follow-up-what-are-you-coming-to-do

export interface AttendeeGroup {
  key: string;
  label: string | null;
  href?: string;
  people: EventRsvp[];
}

/**
 * Members who haven't answered first, unlabelled (any label reads as doubt
 * about attending); then projects (by attendee count, then title), then "New
 * to Code for Philly", "No project yet" — each only when non-empty.
 */
export function groupAttendees(rsvps: EventRsvp[]): AttendeeGroup[] {
  const projects = new Map<string, AttendeeGroup>();
  const newcomers: EventRsvp[] = [];
  const looking: EventRsvp[] = [];
  const unanswered: EventRsvp[] = [];
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
    else unanswered.push(r);
  }
  const groups: AttendeeGroup[] = unanswered.length
    ? [{ key: 'unanswered', label: null, people: unanswered }]
    : [];
  const byProject = [...projects.values()].sort(
    (a, b) => b.people.length - a.people.length || (a.label ?? '').localeCompare(b.label ?? ''),
  );
  groups.push(...byProject);
  if (newcomers.length) groups.push({ key: 'newcomer', label: 'New to Code for Philly', people: newcomers });
  if (looking.length) groups.push({ key: 'no_project', label: 'No project yet', people: looking });
  return groups;
}
