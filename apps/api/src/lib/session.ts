/**
 * Session augmentation shim.
 *
 * auth-jwt-substrate will decorate `request.session` with the validated JWT
 * payload. Until that plan lands, this module provides the type-only
 * declaration and a helper to extract the caller safely.
 *
 * Routes should always use `getCallerSession(request)` rather than accessing
 * `request.session` directly so the call site doesn't need to know whether
 * auth-jwt-substrate has landed.
 */
import type { FastifyRequest } from 'fastify';
import type { CallerSession } from '../services/permissions.js';

/**
 * Augment FastifyRequest with the optional session decorator.
 * auth-jwt-substrate will satisfy this interface; before it does, it's
 * simply `undefined`.
 */
declare module 'fastify' {
  interface FastifyRequest {
    session?: {
      person?: CallerSession;
    };
  }
}

/**
 * Extract the caller from the request session, or return undefined if
 * the request is unauthenticated (or auth-jwt-substrate hasn't landed).
 */
export function getCallerSession(request: FastifyRequest): CallerSession | undefined {
  return request.session?.person;
}
