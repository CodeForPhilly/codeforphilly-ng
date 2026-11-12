/**
 * Agent accounts and their grants — specs/api/agents.md.
 *
 * An agent account is a `people` record an administrator creates here (never
 * through a sign-in), marked as an agent by holding a grant. A grant is a
 * bearer token for it with fixed scopes and an expiry; the public
 * `agent-grants` record says it exists, the private store keeps only the
 * token's hash, and the token itself is returned once, from the mint.
 */
import { uuidv7 } from 'uuidv7';
import {
  AGENT_SCOPES,
  AgentGrantSchema,
  PersonSchema,
  agentEvaluatorFor,
  evaluatorKind,
  type AgentGrant,
  type AgentScope,
  type Person,
} from '@cfp/shared/schemas';

import {
  GRANT_DEFAULT_DAYS,
  GRANT_MAX_DAYS,
  grantsOf,
  isAgentAccount,
  isGrantActive,
  mintAgentToken,
} from '../auth/agent-grant.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { isReservedSlug, isValidPersonSlug } from '../lib/slug.js';
import type { InMemoryState } from '../store/memory/state.js';
import type { PrivateStore } from '../store/private/index.js';
import { StateApply } from '../store/state-apply.js';
import type { DualStoreTx } from '../store/store.js';
import { votesOnAccount } from './votes.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GrantInput {
  readonly label: string;
  readonly scopes: readonly string[];
  readonly expiresInDays?: number;
}

export interface CreateAgentInput {
  readonly slug: string;
  readonly fullName: string;
  readonly bio: string;
  readonly grant?: GrantInput;
}

export interface PersonRef {
  readonly slug: string;
  readonly fullName: string;
}

export interface GrantView {
  readonly id: string;
  readonly label: string;
  readonly scopes: AgentScope[];
  readonly createdAt: string;
  readonly createdBy: PersonRef;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly active: boolean;
}

export interface AgentView {
  readonly person: { readonly slug: string; readonly fullName: string; readonly deletedAt: string | null };
  readonly grants: GrantView[];
  readonly stagedVotes: { readonly spam: number; readonly legit: number };
  readonly purges: { readonly last24h: number; readonly last30d: number };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Validate a grant request: known scopes, at least one, `moderation:purge`
 * only with `moderation:read`, `expiresInDays` 1–180 (default 90).
 */
export function validateGrantInput(input: GrantInput): { label: string; scopes: AgentScope[]; days: number } {
  const fields: Record<string, string> = {};
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (label.length < 1 || label.length > 80) fields['label'] = '1–80 characters';
  const known = new Set<string>(AGENT_SCOPES);
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0) fields['scopes'] = 'at least one scope';
  else if (scopes.some((s) => !known.has(s))) fields['scopes'] = `unknown scope; allowed: ${AGENT_SCOPES.join(', ')}`;
  else if (scopes.includes('moderation:purge') && !scopes.includes('moderation:read')) {
    fields['scopes'] = 'moderation:purge requires moderation:read';
  }
  const days = input.expiresInDays ?? GRANT_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > GRANT_MAX_DAYS) fields['expiresInDays'] = `1–${GRANT_MAX_DAYS}`;
  if (Object.keys(fields).length > 0) throw new ApiValidationError('Invalid grant', fields);
  // Stored in the canonical order, whatever order they were asked for in.
  const ordered = AGENT_SCOPES.filter((s) => scopes.includes(s));
  return { label, scopes: ordered, days };
}

export class AgentService {
  readonly #state: InMemoryState;
  readonly #privateStore: PrivateStore;

  constructor(state: InMemoryState, privateStore: PrivateStore) {
    this.#state = state;
    this.#privateStore = privateStore;
  }

  #person(slug: string): Person | undefined {
    const id = this.#state.personIdBySlug.get(slug);
    return id ? this.#state.people.get(id) : undefined;
  }

  #ref(slug: string): PersonRef {
    return { slug, fullName: this.#person(slug)?.fullName ?? slug };
  }

  grantView(grant: AgentGrant, now: Date = new Date()): GrantView {
    return {
      id: grant.id,
      label: grant.label,
      scopes: [...grant.scopes],
      createdAt: grant.createdAt,
      createdBy: this.#ref(grant.createdBySlug),
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt ?? null,
      lastUsedAt: this.#privateStore.getGrantSecret(grant.id)?.lastUsedAt ?? null,
      active: isGrantActive(grant, now),
    };
  }

  /** Every agent account, its grants, staged votes and recent purges. */
  list(now: Date = new Date()): AgentView[] {
    const out: AgentView[] = [];
    for (const slug of [...this.#state.agentGrantsByPerson.keys()].sort()) {
      const person = this.#person(slug);
      out.push({
        person: { slug, fullName: person?.fullName ?? slug, deletedAt: person?.deletedAt ?? null },
        grants: grantsOf(this.#state, slug)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((g) => this.grantView(g, now)),
        stagedVotes: this.stagedVoteCounts(slug),
        purges: this.purgeCounts(slug, now),
      });
    }
    return out;
  }

  /** The agent's votes on people no human has voted on (on their account). */
  stagedVoteCounts(agentSlug: string): { spam: number; legit: number } {
    const evaluator = agentEvaluatorFor(agentSlug);
    const counts = { spam: 0, legit: 0 };
    for (const person of this.#state.people.values()) {
      const votes = votesOnAccount(this.#state, person);
      const mine = votes.find((v) => v.evaluator === evaluator);
      if (!mine || votes.some((v) => evaluatorKind(v.evaluator) === 'human')) continue;
      if (mine.verdict === 'spam') counts.spam++;
      else if (mine.verdict === 'legit') counts.legit++;
    }
    return counts;
  }

  purgeCounts(agentSlug: string, now: Date = new Date()): { last24h: number; last30d: number } {
    const by = agentEvaluatorFor(agentSlug);
    let last24h = 0;
    let last30d = 0;
    for (const p of this.#state.spamPurges.values()) {
      if (p.by !== by) continue;
      const age = now.getTime() - Date.parse(p.purgedAt);
      if (age < DAY_MS) last24h++;
      if (age < 30 * DAY_MS) last30d++;
    }
    return { last24h, last30d };
  }

  /** The agent account `slug`, or 404 when there is none. */
  agentOr404(slug: string): Person {
    const person = this.#person(slug);
    if (!person || !isAgentAccount(this.#state, slug)) throw new ApiNotFoundError(`No agent '${slug}'`);
    return person;
  }

  /**
   * Create the agent's person record (no sign-in identity, no private
   * profile) and, optionally, its first grant, in one transaction.
   */
  async create(
    tx: DualStoreTx,
    createdBySlug: string,
    input: CreateAgentInput,
    ids: { readonly personId?: string; readonly grantId?: string } = {},
  ): Promise<{ person: Person; grant: AgentGrant | null; token: string | null; stateApply: StateApply }> {
    const fields: Record<string, string> = {};
    const slug = typeof input.slug === 'string' ? input.slug.trim().toLowerCase() : '';
    if (!isValidPersonSlug(slug)) fields['slug'] = 'invalid format';
    else if (isReservedSlug(slug)) fields['slug'] = 'slug_reserved';
    else if (this.#state.personIdBySlug.has(slug)) fields['slug'] = 'slug_taken';
    const fullName = typeof input.fullName === 'string' ? input.fullName.trim() : '';
    if (fullName.length < 1 || fullName.length > 120) fields['fullName'] = '1–120 characters';
    const bio = typeof input.bio === 'string' ? input.bio.trim() : '';
    if (bio.length < 1) fields['bio'] = 'required: say what the agent is and who runs it';
    else if (bio.length > 10_000) fields['bio'] = 'max 10000 characters';
    const grantInput = input.grant ? validateGrantInput(input.grant) : null;
    if (Object.keys(fields).length > 0) throw new ApiValidationError('Invalid agent', fields);

    const now = nowIso();
    const person = PersonSchema.parse({
      id: ids.personId ?? uuidv7(),
      slug,
      fullName,
      bio,
      accountLevel: 'user',
      createdAt: now,
      updatedAt: now,
    });
    await tx.public.people.upsert(person);
    const stateApply = new StateApply().upsertPerson(person);

    let grant: AgentGrant | null = null;
    let token: string | null = null;
    if (grantInput) {
      const minted = await this.#writeGrant(tx, stateApply, person, createdBySlug, grantInput, now, ids.grantId);
      grant = minted.grant;
      token = minted.token;
    }
    return { person, grant, token, stateApply };
  }

  /** Mint a grant for an existing agent account; the token is returned once. */
  async mint(
    tx: DualStoreTx,
    agentSlug: string,
    createdBySlug: string,
    input: GrantInput,
    grantId?: string,
  ): Promise<{ grant: AgentGrant; token: string; stateApply: StateApply }> {
    const person = this.agentOr404(agentSlug);
    const valid = validateGrantInput(input);
    const stateApply = new StateApply();
    const { grant, token } = await this.#writeGrant(tx, stateApply, person, createdBySlug, valid, nowIso(), grantId);
    return { grant, token, stateApply };
  }

  async #writeGrant(
    tx: DualStoreTx,
    stateApply: StateApply,
    person: Person,
    createdBySlug: string,
    input: { label: string; scopes: AgentScope[]; days: number },
    now: string,
    grantId: string = uuidv7(),
  ): Promise<{ grant: AgentGrant; token: string }> {
    const grant = AgentGrantSchema.parse({
      id: grantId,
      personSlug: person.slug,
      label: input.label,
      scopes: input.scopes,
      createdAt: now,
      createdBySlug,
      expiresAt: new Date(Date.parse(now) + input.days * DAY_MS).toISOString(),
    });
    const { token, tokenHash } = mintAgentToken();
    await tx.public['agent-grants'].upsert(grant);
    tx.private.putGrantSecret({ grantId: grant.id, personId: person.id, tokenHash });
    stateApply.upsertAgentGrant(grant);
    return { grant, token };
  }

  /** The grant `grantId` of agent `agentSlug`, or 404. */
  grantOr404(agentSlug: string, grantId: string): AgentGrant {
    this.agentOr404(agentSlug);
    const grant = this.#state.agentGrants.get(grantId);
    if (!grant || grant.personSlug !== agentSlug) throw new ApiNotFoundError(`No grant '${grantId}'`);
    return grant;
  }

  /** Revoke at once; revoking a revoked grant is a no-op (no commit). */
  async revoke(
    tx: DualStoreTx,
    agentSlug: string,
    grantId: string,
  ): Promise<{ grant: AgentGrant; stateApply: StateApply }> {
    const existing = this.grantOr404(agentSlug, grantId);
    if (existing.revokedAt) return { grant: existing, stateApply: new StateApply() };
    const grant = AgentGrantSchema.parse({ ...existing, revokedAt: nowIso() });
    await tx.public['agent-grants'].upsert(grant);
    return { grant, stateApply: new StateApply().upsertAgentGrant(grant) };
  }
}
