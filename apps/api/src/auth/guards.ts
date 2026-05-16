/**
 * Route auth guard helpers.
 *
 * Routes that require authentication call requireAuth() with the needed markers.
 * The function throws UnauthenticatedError or ForbiddenError as appropriate.
 *
 * Markers follow specs/behaviors/authorization.md.
 */
import type { FastifyRequest } from 'fastify';
import { UnauthenticatedError, ForbiddenError } from '../lib/errors.js';
import type { SessionContext } from './middleware.js';

export type AuthMarker = 'public' | 'user' | 'staff' | 'administrator' | 'self';

/**
 * Assert the request has a valid session meeting at least one of the given markers.
 * Returns the session context for convenience.
 */
export function requireAuth(request: FastifyRequest, markers: AuthMarker[]): SessionContext {
  const session = request.session;

  if (markers.includes('public')) return session;

  if (session.accountLevel === 'anonymous' || (!session.personId && !session.person)) {
    throw new UnauthenticatedError('Authentication required');
  }

  if (markers.includes('user')) return session;

  if (markers.includes('staff')) {
    if (session.accountLevel === 'staff' || session.accountLevel === 'administrator') {
      return session;
    }
  }

  if (markers.includes('administrator')) {
    if (session.accountLevel === 'administrator') return session;
  }

  throw new ForbiddenError('Insufficient permissions');
}
