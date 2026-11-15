/**
 * Who is calling a staff surface that agents may also reach —
 * specs/api/moderation.md (`staff | agent:<scope>`), specs/api/agents.md.
 *
 * Anyone who doesn't qualify gets `404 not_found`, like the rest of
 * `/api/admin`: the endpoints' existence is not a signal.
 */
import type { AgentScope } from '@cfp/shared/schemas';
import type { FastifyRequest } from 'fastify';

import { ApiNotFoundError } from '../lib/errors.js';
import { agentSessionContext, type AgentPrincipal } from './agent-grant.js';
import type { SessionContext } from './middleware.js';

export type ModerationCaller =
  | { readonly kind: 'staff'; readonly session: SessionContext; readonly agent: null }
  | { readonly kind: 'agent'; readonly session: SessionContext; readonly agent: AgentPrincipal };

function isStaffSession(session: SessionContext): boolean {
  return !session.agent && (session.accountLevel === 'staff' || session.accountLevel === 'administrator');
}

/**
 * The caller as staff, or as an agent whose grant carries `scope` (omit it
 * for a staff-only surface). Anything else → 404.
 */
export function moderationCaller(request: FastifyRequest, scope?: AgentScope): ModerationCaller {
  const agent = request.agent;
  if (agent) {
    if (scope && agent.scopes.has(scope)) return { kind: 'agent', session: agentSessionContext(agent), agent };
    throw new ApiNotFoundError('Not found');
  }
  if (isStaffSession(request.session)) return { kind: 'staff', session: request.session, agent: null };
  throw new ApiNotFoundError('Not found');
}

/** An agent whose grant carries `scope`; staff and everyone else → 404. */
export function agentCaller(
  request: FastifyRequest,
  scope: AgentScope,
): Extract<ModerationCaller, { kind: 'agent' }> {
  const agent = request.agent;
  if (agent && agent.scopes.has(scope)) return { kind: 'agent', session: agentSessionContext(agent), agent };
  throw new ApiNotFoundError('Not found');
}

/** Staff (or administrators); agents and everyone else → 404. */
export function staffCaller(request: FastifyRequest): SessionContext {
  if (!request.agent && isStaffSession(request.session)) return request.session;
  throw new ApiNotFoundError('Not found');
}

/** Administrators only; agents and everyone else → 404. */
export function administratorCaller(request: FastifyRequest): SessionContext {
  if (!request.agent && !request.session.agent && request.session.accountLevel === 'administrator') {
    return request.session;
  }
  throw new ApiNotFoundError('Not found');
}
