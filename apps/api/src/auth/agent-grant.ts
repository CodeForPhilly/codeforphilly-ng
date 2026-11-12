/**
 * Agent grants — specs/behaviors/authorization.md → "Agent grants",
 * specs/api/agents.md → "Grants".
 *
 * A grant is an opaque bearer token (`cfpa_` + 32 random bytes, base64url) an
 * administrator mints for an agent account. Only its SHA-256 is stored (the
 * private store's `agent-grant-secrets.jsonl`); the public `agent-grants`
 * record says that it exists, for whom, with which scopes and until when.
 *
 * A request carrying one is anonymous to every route except those that name
 * one of its scopes: the session middleware leaves `request.session`
 * anonymous and puts the agent on `request.agent`, so no existing route can
 * mistake it for a signed-in person.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { AgentGrant, AgentScope, Person } from '@cfp/shared/schemas';

import type { InMemoryState } from '../store/memory/state.js';
import type { PrivateStore } from '../store/private/index.js';
import type { SessionContext } from './middleware.js';

export const AGENT_TOKEN_PREFIX = 'cfpa_';

/** How often `lastUsedAt` may be written for one grant. */
export const LAST_USED_WRITE_INTERVAL_MS = 60 * 60 * 1000;

export const GRANT_DEFAULT_DAYS = 90;
export const GRANT_MAX_DAYS = 180;

/** The caller behind a valid agent grant. */
export interface AgentPrincipal {
  readonly person: Person;
  readonly grant: AgentGrant;
  readonly scopes: ReadonlySet<AgentScope>;
}

/** A fresh token and the hash that is all the site keeps of it. */
export function mintAgentToken(): { token: string; tokenHash: string } {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashAgentToken(token) };
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The `cfpa_…` token in an `Authorization: Bearer` header, or null when the
 * header is absent or carries something else.
 */
export function bearerAgentToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  const token = match?.[1];
  return token && token.startsWith(AGENT_TOKEN_PREFIX) ? token : null;
}

/** Not revoked and not expired at `now`. */
export function isGrantActive(grant: AgentGrant, now: Date = new Date()): boolean {
  return !grant.revokedAt && Date.parse(grant.expiresAt) > now.getTime();
}

/** A person with any grant on record is an agent account (specs/api/agents.md). */
export function isAgentAccount(state: InMemoryState, slug: string): boolean {
  return (state.agentGrantsByPerson.get(slug)?.size ?? 0) > 0;
}

/** Whether the agent `slug` holds at least one active grant at `now`. */
export function agentHasActiveGrant(state: InMemoryState, slug: string, now: Date = new Date()): boolean {
  for (const id of state.agentGrantsByPerson.get(slug) ?? []) {
    const grant = state.agentGrants.get(id);
    if (grant && isGrantActive(grant, now)) return true;
  }
  return false;
}

/** Every grant of one agent account. */
export function grantsOf(state: InMemoryState, slug: string): AgentGrant[] {
  return [...(state.agentGrantsByPerson.get(slug) ?? [])]
    .map((id) => state.agentGrants.get(id))
    .filter((g): g is AgentGrant => g !== undefined);
}

/**
 * Resolve a presented token to its agent, or null when anything is wrong:
 * unknown hash, no grant record, revoked, expired, or an agent account that
 * is missing, deactivated, or not `accountLevel = user`.
 */
export function resolveAgentToken(
  token: string,
  state: InMemoryState,
  privateStore: PrivateStore,
  now: Date = new Date(),
): AgentPrincipal | null {
  const secret = privateStore.getGrantSecretByHash(hashAgentToken(token));
  if (!secret) return null;
  const grant = state.agentGrants.get(secret.grantId);
  if (!grant || !isGrantActive(grant, now)) return null;
  const personId = state.personIdBySlug.get(grant.personSlug);
  const person = personId ? state.people.get(personId) : undefined;
  if (!person || person.id !== secret.personId) return null;
  if (person.deletedAt || person.accountLevel !== 'user') return null;
  return { person, grant, scopes: new Set(grant.scopes) };
}

/**
 * The session an agent's own writes are made as: the agent account as
 * `person` (commits are authored by it; self-checks apply), level `user`,
 * and the grant, which every marker but `agent:<scope>` treats as anonymous.
 */
export function agentSessionContext(agent: AgentPrincipal): SessionContext {
  return {
    person: agent.person,
    accountLevel: 'user',
    personId: agent.person.id,
    agent: { grantId: agent.grant.id, scopes: [...agent.scopes] },
  };
}
