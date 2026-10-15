/**
 * Permission computation helpers.
 *
 * All permission decisions are centralized here so the logic doesn't
 * scatter across route handlers. Routes call these with the caller
 * (which may be undefined for unauthenticated requests) and the entity.
 *
 * The caller is derived from `request.session.person` (decorated by the
 * session middleware in auth-jwt-substrate) via `getCallerSession()` below.
 */
import type { FastifyRequest } from 'fastify';
import type { Event, Person, Project, ProjectBuzz, ProjectMembership, ProjectUpdate } from '@cfp/shared/schemas';
import type { HelpWantedRole } from '@cfp/shared/schemas';

/** Minimal caller shape used by permission helpers. Derived from `request.session.person`. */
export interface CallerSession {
  readonly id: string;
  /** The caller's person slug — memberships reference people by slug. */
  readonly slug: string;
  readonly accountLevel: 'user' | 'staff' | 'administrator';
}

/**
 * Extract the caller's session view from a Fastify request. Returns undefined
 * for anonymous or claim-pending requests (where `session.person` is null or
 * accountLevel is `'anonymous'`).
 */
export function getCallerSession(request: FastifyRequest): CallerSession | undefined {
  const person = request.session.person;
  if (!person) return undefined;
  const level = person.accountLevel;
  if (level !== 'user' && level !== 'staff' && level !== 'administrator') return undefined;
  return { id: person.id, slug: person.slug, accountLevel: level };
}

export interface ProjectPermissions {
  readonly canEdit: boolean;
  readonly canManageMembers: boolean;
  readonly canPostUpdate: boolean;
  readonly canLogBuzz: boolean;
  readonly canPostHelpWanted: boolean;
  readonly canDelete: boolean;
}

export interface PersonPermissions {
  readonly canEdit: boolean;
  readonly canChangeAccountLevel: boolean;
  /** Self or staff: can deactivate/reactivate this account. */
  readonly canDeactivate: boolean;
  /** Admin only: can purge this person and all their content. */
  readonly canPurge: boolean;
}

export interface UpdatePermissions {
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

export interface BuzzPermissions {
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

export interface HelpWantedPermissions {
  readonly canEdit: boolean;
  readonly canExpressInterest: boolean;
  readonly alreadyExpressedInterest: boolean;
  readonly canFill: boolean;
  readonly canClose: boolean;
}

function isStaff(caller: CallerSession | undefined): boolean {
  return caller?.accountLevel === 'staff' || caller?.accountLevel === 'administrator';
}

function isMaintainerOf(
  caller: CallerSession | undefined,
  project: Project,
  memberships: ProjectMembership[],
): boolean {
  if (!caller) return false;
  if (project.maintainerId === caller.id) return true;
  return memberships.some((m) => m.personSlug === caller.slug && m.isMaintainer);
}

function isMemberOf(
  caller: CallerSession | undefined,
  projectSlug: string,
  memberships: ProjectMembership[],
): boolean {
  if (!caller) return false;
  return memberships.some((m) => m.projectSlug === projectSlug && m.personSlug === caller.slug);
}

export function computeProjectPermissions(
  caller: CallerSession | undefined,
  project: Project,
  memberships: ProjectMembership[],
): ProjectPermissions {
  const staff = isStaff(caller);
  const maintainer = isMaintainerOf(caller, project, memberships);
  const member = isMemberOf(caller, project.slug, memberships);
  const authenticated = caller !== undefined;

  return {
    canEdit: maintainer || staff,
    canManageMembers: maintainer || staff,
    canPostUpdate: member || staff,
    canLogBuzz: authenticated,
    canPostHelpWanted: maintainer || staff,
    canDelete: staff,
  };
}

export function computePersonPermissions(
  caller: CallerSession | undefined,
  person: Person,
): PersonPermissions {
  const staff = isStaff(caller);
  const admin = caller?.accountLevel === 'administrator';
  const isSelf = caller?.id === person.id;
  return {
    canEdit: isSelf || staff,
    canChangeAccountLevel: admin,
    canDeactivate: isSelf || staff,
    canPurge: admin,
  };
}

export function computeUpdatePermissions(
  caller: CallerSession | undefined,
  update: ProjectUpdate,
): UpdatePermissions {
  const staff = isStaff(caller);
  const isAuthor = caller !== undefined && caller.id === update.authorId;
  return {
    canEdit: isAuthor || staff,
    canDelete: isAuthor || staff,
  };
}

export function computeBuzzPermissions(
  caller: CallerSession | undefined,
  buzz: ProjectBuzz,
): BuzzPermissions {
  const staff = isStaff(caller);
  const isPoster = caller !== undefined && caller.id === buzz.postedById;
  return {
    canEdit: isPoster || staff,
    canDelete: isPoster || staff,
  };
}

export interface EventPermissions {
  /** True exactly when a PUT …/rsvp from this caller would succeed. */
  readonly canRsvp: boolean;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  readonly canCancel: boolean;
  readonly canDelete: boolean;
}

/** RSVP window per specs/behaviors/events.md#rsvp-window: scheduled and not yet ended. */
export function isRsvpOpen(event: Event, now: Date = new Date()): boolean {
  return event.status === 'scheduled' && new Date(event.endsAt) > now;
}

export function computeEventPermissions(
  caller: CallerSession | undefined,
  event: Event,
  rsvpCount: number,
  now: Date = new Date(),
): EventPermissions {
  const staff = isStaff(caller);
  return {
    canRsvp: caller !== undefined && isRsvpOpen(event, now),
    canEdit: staff,
    canPublish: staff && event.status === 'draft',
    canCancel: staff && event.status === 'scheduled',
    canDelete: staff && (event.status === 'draft' || rsvpCount === 0),
  };
}

export interface EventSeriesPermissions {
  readonly canEdit: boolean;
  /** Staff, and only while no event references the series. */
  readonly canDelete: boolean;
}

export function computeEventSeriesPermissions(
  caller: CallerSession | undefined,
  eventCount: number,
): EventSeriesPermissions {
  const staff = isStaff(caller);
  return { canEdit: staff, canDelete: staff && eventCount === 0 };
}

export function computeHelpWantedPermissions(
  caller: CallerSession | undefined,
  role: HelpWantedRole,
  project: Project,
  memberships: ProjectMembership[],
  alreadyExpressedInterest: boolean,
): HelpWantedPermissions {
  const staff = isStaff(caller);
  const maintainer = isMaintainerOf(caller, project, memberships);
  const isPoster = caller !== undefined && caller.id === role.postedById;
  const authenticated = caller !== undefined;

  return {
    canEdit: isPoster || maintainer || staff,
    canExpressInterest: authenticated && role.status === 'open' && !alreadyExpressedInterest,
    alreadyExpressedInterest,
    canFill: maintainer || staff,
    canClose: maintainer || staff,
  };
}
