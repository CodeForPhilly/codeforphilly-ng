/**
 * requireAuth — typed entry point for marker-based authorization.
 *
 * Wraps the simpler route-level guard from ./guards.ts with marker
 * vocabulary from specs/behaviors/authorization.md. Used at the service
 * boundary for defense-in-depth: routes call requireAuth(request, markers)
 * first; services then call requireAuthMarker(session, marker, ctx) again
 * with full entity context (project, owned-resource, self) to decide
 * `self`, `member`, `maintainer`, `poster`/`author` cases.
 */
import type { Project, ProjectMembership } from '@cfp/shared/schemas';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors.js';
import type { SessionContext } from './middleware.js';

/** A marker expression: `user`, `maintainer | staff`, `self | staff`, etc. */
export type MarkerExpression = string;

export interface AuthContext {
  /** Caller's session. */
  readonly session: SessionContext;
  /** When `self` is in the expression — the resource owner's personId or slug. */
  readonly selfId?: string;
  readonly selfSlug?: string;
  /** When `maintainer` / `member` are in the expression — the project + its memberships. */
  readonly project?: Project;
  readonly memberships?: readonly ProjectMembership[];
  /** When `poster`/`author` is in the expression — the resource owner's personId. */
  readonly ownerId?: string;
}

function isStaff(session: SessionContext): boolean {
  return session.accountLevel === 'staff' || session.accountLevel === 'administrator';
}

function isAdministrator(session: SessionContext): boolean {
  return session.accountLevel === 'administrator';
}

function isAuthenticated(session: SessionContext): boolean {
  return session.accountLevel !== 'anonymous' && session.person !== null;
}

function isSelf(session: SessionContext, ctx: AuthContext): boolean {
  if (!session.person) return false;
  if (ctx.selfId !== undefined) return session.person.id === ctx.selfId;
  if (ctx.selfSlug !== undefined) return session.person.slug === ctx.selfSlug;
  return false;
}

function isMaintainer(session: SessionContext, ctx: AuthContext): boolean {
  if (!session.person || !ctx.project) return false;
  if (ctx.project.maintainerId === session.person.id) return true;
  return (ctx.memberships ?? []).some(
    (m) => m.personId === session.person!.id && m.isMaintainer,
  );
}

function isMember(session: SessionContext, ctx: AuthContext): boolean {
  if (!session.person || !ctx.project) return false;
  return (ctx.memberships ?? []).some(
    (m) => m.personId === session.person!.id && m.projectId === ctx.project!.id,
  );
}

function isOwner(session: SessionContext, ctx: AuthContext): boolean {
  if (!session.person || ctx.ownerId === undefined) return false;
  return session.person.id === ctx.ownerId;
}

const MARKER_TOKENS = new Set([
  'public',
  'user',
  'self',
  'staff',
  'administrator',
  'member',
  'maintainer',
  'poster',
  'author',
]);

/**
 * Check a marker expression like `maintainer | staff` against the session.
 *
 * Throws `UnauthenticatedError` if any non-`public` marker is required and the
 * caller is anonymous; throws `ForbiddenError` if the caller is authenticated
 * but none of the markers match.
 */
export function requireAuth(expression: MarkerExpression, ctx: AuthContext): SessionContext {
  const tokens = expression
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error(`requireAuth: empty marker expression`);
  }
  for (const t of tokens) {
    if (!MARKER_TOKENS.has(t)) {
      throw new Error(`requireAuth: unknown marker '${t}' in '${expression}'`);
    }
  }

  const { session } = ctx;

  if (tokens.includes('public')) return session;

  // Every remaining marker requires authentication.
  if (!isAuthenticated(session)) {
    throw new UnauthenticatedError('Authentication required');
  }

  for (const token of tokens) {
    if (token === 'user' && isAuthenticated(session)) return session;
    if (token === 'staff' && isStaff(session)) return session;
    if (token === 'administrator' && isAdministrator(session)) return session;
    if (token === 'self' && isSelf(session, ctx)) return session;
    if (token === 'maintainer' && isMaintainer(session, ctx)) return session;
    if (token === 'member' && isMember(session, ctx)) return session;
    if ((token === 'poster' || token === 'author') && isOwner(session, ctx)) return session;
  }

  throw new ForbiddenError('Insufficient permissions');
}

/** Convenience: throws `UnauthenticatedError` unless the caller is signed in. */
export function requireSignedIn(session: SessionContext): SessionContext {
  if (!isAuthenticated(session)) {
    throw new UnauthenticatedError('Authentication required');
  }
  return session;
}
