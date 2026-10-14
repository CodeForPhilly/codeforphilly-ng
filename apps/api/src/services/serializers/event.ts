/**
 * Event + EventRsvp serializers — specs/api/events.md#event-shape.
 */
import type { Event, EventAgendaItem, EventRsvp, Person, Project } from '@cfp/shared/schemas';

import type { EventPermissions } from '../permissions.js';
import { renderMarkdown, serializePersonAvatar, type PersonAvatar } from './common.js';

export interface ProjectRef {
  readonly slug: string;
  readonly title: string;
}

export interface SeriesRef {
  readonly slug: string;
  readonly title: string;
}

export interface ViewerRsvpResponse {
  readonly plan: EventRsvp['plan'] | null;
  readonly project: ProjectRef | null;
  readonly createdAt: string;
}

export interface EventAgendaItemResponse {
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly title: string;
  readonly venueName: string | null;
  readonly venueAddress: string | null;
  readonly description: string | null;
  readonly descriptionHtml: string | null;
}

export interface EventSummaryResponse {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly venueName: string | null;
  readonly venueAddress: string | null;
  readonly onlineUrl: string | null;
  readonly meetupUrl: string | null;
  readonly series: SeriesRef | null;
  readonly status: Event['status'];
  readonly cancelledAt: string | null;
  readonly rsvpCount: number;
  readonly viewerRsvp: ViewerRsvpResponse | null;
  readonly icsUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EventResponse extends EventSummaryResponse {
  /** Projects the caller named on RSVPs to other events, newest first (specs/api/events.md). */
  readonly viewerRecentProjects: ProjectRef[];
  /** The last ten distinct projects anyone named on any RSVP, newest first. */
  readonly recentProjects: ProjectRef[];
  readonly description: string | null;
  readonly descriptionHtml: string;
  readonly agenda: EventAgendaItemResponse[];
  readonly cancellationNote: string | null;
  readonly permissions: EventPermissions;
}

export interface EventRsvpResponse {
  readonly person: PersonAvatar | null;
  readonly plan: EventRsvp['plan'] | null;
  readonly project: ProjectRef | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProjectLookup = (projectId: string) => Project | undefined;

function projectRef(projectId: string | null | undefined, lookup: ProjectLookup): ProjectRef | null {
  if (!projectId) return null;
  const p = lookup(projectId);
  if (!p || p.deletedAt) return null;
  return { slug: p.slug, title: p.title };
}

export function serializeViewerRsvp(rsvp: EventRsvp | null, lookup: ProjectLookup): ViewerRsvpResponse | null {
  if (!rsvp) return null;
  return {
    plan: rsvp.plan ?? null,
    project: rsvp.plan === 'project' ? projectRef(rsvp.projectId, lookup) : null,
    createdAt: rsvp.createdAt,
  };
}

export interface SerializeEventOptions {
  readonly rsvpCount: number;
  readonly viewerRsvp: EventRsvp | null;
  readonly projectLookup: ProjectLookup;
  /** Series ref — null until the series plan lands. */
  readonly series?: SeriesRef | null;
}

export function serializeEventSummary(event: Event, opts: SerializeEventOptions): EventSummaryResponse {
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    venueName: event.venueName ?? null,
    venueAddress: event.venueAddress ?? null,
    onlineUrl: event.onlineUrl ?? null,
    meetupUrl: event.meetupUrl ?? null,
    series: opts.series ?? null,
    status: event.status,
    cancelledAt: event.cancelledAt ?? null,
    rsvpCount: opts.rsvpCount,
    viewerRsvp: serializeViewerRsvp(opts.viewerRsvp, opts.projectLookup),
    icsUrl: `/api/events/${encodeURIComponent(event.slug)}/ics`,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function serializeAgendaItem(item: EventAgendaItem): EventAgendaItemResponse {
  return {
    startsAt: item.startsAt,
    endsAt: item.endsAt ?? null,
    title: item.title,
    venueName: item.venueName ?? null,
    venueAddress: item.venueAddress ?? null,
    description: item.description ?? null,
    descriptionHtml: item.description ? renderMarkdown(item.description).html : null,
  };
}

export function serializeEvent(
  event: Event,
  opts: SerializeEventOptions & {
    readonly permissions: EventPermissions;
    readonly viewerRecentProjects: ProjectRef[];
    readonly recentProjects: ProjectRef[];
  },
): EventResponse {
  return {
    ...serializeEventSummary(event, opts),
    // A body-less markdown record reads back as '' — present it as absent.
    description: event.description || null,
    descriptionHtml: event.description ? renderMarkdown(event.description).html : '',
    agenda: (event.agenda ?? []).map(serializeAgendaItem),
    cancellationNote: event.cancellationNote ?? null,
    viewerRecentProjects: opts.viewerRecentProjects,
    recentProjects: opts.recentProjects,
    permissions: opts.permissions,
  };
}

export function serializeEventRsvp(
  rsvp: EventRsvp,
  person: Person | undefined | null,
  lookup: ProjectLookup,
): EventRsvpResponse {
  return {
    person: serializePersonAvatar(person),
    plan: rsvp.plan ?? null,
    project: rsvp.plan === 'project' ? projectRef(rsvp.projectId, lookup) : null,
    createdAt: rsvp.createdAt,
    updatedAt: rsvp.updatedAt,
  };
}
