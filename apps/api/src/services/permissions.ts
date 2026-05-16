/**
 * Permission computation helpers.
 *
 * All permission decisions are centralized here so the logic doesn't
 * scatter across route handlers. Routes call these with the caller
 * (which may be undefined for unauthenticated requests) and the entity.
 *
 * request.session?.person is provided by auth-jwt-substrate. We use
 * optional chaining everywhere so this module works before that plan lands.
 */
import type { Person, Project, ProjectBuzz, ProjectMembership, ProjectUpdate } from '@cfp/shared/schemas';
import type { HelpWantedRole } from '@cfp/shared/schemas';

/** Minimal caller shape — populated by auth-jwt-substrate. */
export interface CallerSession {
  readonly id: string;
  readonly accountLevel: 'user' | 'staff' | 'administrator';
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
  return memberships.some((m) => m.personId === caller.id && m.isMaintainer);
}

function isMemberOf(
  caller: CallerSession | undefined,
  projectId: string,
  memberships: ProjectMembership[],
): boolean {
  if (!caller) return false;
  return memberships.some((m) => m.projectId === projectId && m.personId === caller.id);
}

export function computeProjectPermissions(
  caller: CallerSession | undefined,
  project: Project,
  memberships: ProjectMembership[],
): ProjectPermissions {
  const staff = isStaff(caller);
  const maintainer = isMaintainerOf(caller, project, memberships);
  const member = isMemberOf(caller, project.id, memberships);
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
  const isSelf = caller?.id === person.id;
  return {
    canEdit: isSelf || staff,
    canChangeAccountLevel: caller?.accountLevel === 'administrator',
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
