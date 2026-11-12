/**
 * Agent purge — specs/api/moderation.md → `POST /api/admin/members/:slug/purge`
 * and "Agent purges"; specs/behaviors/person-lifecycle.md → Agent purge.
 *
 * An agent holding `moderation:purge` purges a brand-new member who has
 * *posted* spam, at once, citing the records that are the spam. The site
 * checks the evidence is the member's, not empty, and goes with the purge,
 * and that the eight agent purge rules hold; it does not judge the content.
 * The cascade is the administrator's purge; one commit per purge, with a
 * `spam-purges` record and the agent's `spam` vote as the durable "why".
 */
import {
  PersonEvaluationSchema,
  SPAM_EVIDENCE_RECORDS,
  SpamPurgeSchema,
  agentEvaluatorFor,
  type Person,
  type PersonEvaluation,
  type Project,
  type SpamEvidenceRecord,
  type SpamPurge,
  type SpamPurgeEvidence,
} from '@cfp/shared/schemas';

import { isAgentAccount, isGrantActive } from '../auth/agent-grant.js';
import type { SessionContext } from '../auth/middleware.js';
import { ApiNotFoundError, ApiValidationError, ConflictError, RateLimitedError } from '../lib/errors.js';
import { projectBySlug, projectChildKey, type InMemoryState } from '../store/memory/state.js';
import type { PrivateStore } from '../store/private/index.js';
import { StateApply } from '../store/state-apply.js';
import type { DualStoreTx } from '../store/store.js';
import { validateFlags } from './moderation.js';
import { purgePeople } from './person-purge.js';
import { isTouchedByOthers, projectsCreatedBy, purgeableProjects } from './project-purge.js';
import { agentVotesOnAccount, hasHumanVote } from './votes.js';

/** Agent purge limits — specs/api/moderation.md → Agent purges. */
export const AGENT_PURGES_PER_DAY = 5;
export const AGENT_PURGE_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE = 5;

/** One cited record, as the agent sends it. */
export interface EvidenceInput {
  readonly record: string;
  readonly field?: string;
  readonly project?: string;
  readonly number?: number;
  readonly slug?: string;
  readonly roleId?: string;
}

export interface AgentPurgeInput {
  readonly reason: string;
  readonly flags?: readonly string[];
  readonly evidence: readonly EvidenceInput[];
  readonly dryRun?: boolean;
}

export interface PurgeDeleted {
  readonly projects: Array<{ slug: string; title: string }>;
  readonly memberships: number;
  readonly updates: number;
  readonly buzz: number;
  readonly helpWantedRoles: number;
  readonly rsvps: number;
}

/** A validated request: the reason, flags, and each evidence item with its data-repo path. */
export interface ValidatedPurge {
  readonly reason: string;
  readonly flags: string[];
  readonly evidence: Array<SpamPurgeEvidence & { readonly input: EvidenceInput }>;
}

/**
 * Whether `text` carries a URL: a scheme, a `www.` host, or a bare domain
 * followed by a path (`shop.example/deals`). A purge reason is committed
 * forever; it must cite the record, never republish the spam link.
 */
export function containsUrl(text: string): boolean {
  return (
    /[a-z][a-z0-9+.-]*:\/\//i.test(text) ||
    /\bwww\./i.test(text) ||
    /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}\/\S*/i.test(text)
  );
}

const TEXT_FIELDS: Readonly<Record<SpamEvidenceRecord, readonly string[] | null>> = {
  person: ['bio'],
  project: ['title', 'summary', 'overview'],
  'project-update': null,
  'project-buzz': null,
  'help-wanted-role': null,
};

/**
 * Validate the body and give each evidence item its data-repo path — a pure
 * function of the request and the member's slug, so the commit's `Evidence:`
 * trailers are known before the transaction opens.
 */
export function validatePurgeBody(memberSlug: string, body: AgentPurgeInput): ValidatedPurge {
  const fields: Record<string, string> = {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 1 || reason.length > 1000) fields['reason'] = 'required, 1–1000 characters';
  else if (containsUrl(reason)) fields['reason'] = 'must not contain a URL: cite the record as evidence instead';
  let flags: string[] = [];
  try {
    flags = validateFlags(body.flags);
  } catch {
    fields['flags'] = '0–10 tags matching ^[a-z0-9][a-z0-9:-]{0,39}$';
  }
  const items = Array.isArray(body.evidence) ? body.evidence : [];
  if (items.length < 1 || items.length > MAX_EVIDENCE) fields['evidence'] = `1–${MAX_EVIDENCE} items`;
  if (Object.keys(fields).length > 0) throw new ApiValidationError('Invalid purge request', fields);

  const evidence = items.map((item, i) => {
    const bad = (why: string): never => {
      throw new ApiValidationError(`Evidence item ${i}: ${why}`, { [`evidence.${i}`]: why }, 'evidence_invalid');
    };
    if (!(SPAM_EVIDENCE_RECORDS as readonly string[]).includes(item.record)) {
      bad(`record must be one of ${SPAM_EVIDENCE_RECORDS.join(', ')}`);
    }
    const record = item.record as SpamEvidenceRecord;
    const allowed = TEXT_FIELDS[record];
    if (item.field !== undefined && (allowed === null || !allowed.includes(item.field))) {
      bad(allowed === null ? 'this record takes no field' : `field must be one of ${allowed.join(', ')}`);
    }
    if (record === 'person' && item.field !== 'bio') bad('a person is cited by field "bio"');
    let path: string;
    switch (record) {
      case 'person':
        path = `people/${memberSlug}.toml`;
        break;
      case 'project':
        if (!item.project) bad('project (slug) is required');
        path = `projects/${item.project}.toml`;
        break;
      case 'project-update':
        if (!item.project || !Number.isInteger(item.number)) bad('project and number are required');
        path = `project-updates/${item.project}/${item.number}.toml`;
        break;
      case 'project-buzz':
        if (!item.project || !item.slug) bad('project and slug are required');
        path = `project-buzz/${item.project}/${item.slug}.toml`;
        break;
      case 'help-wanted-role':
        if (!item.project || !item.roleId) bad('project and roleId are required');
        path = `help-wanted-roles/${item.project}/${item.roleId}.toml`;
        break;
    }
    return { record, ...(item.field ? { field: item.field } : {}), path, input: item };
  });
  return { reason, flags, evidence };
}

/** The `Evidence:` trailer value for one item: `<path>[#<field>]`. */
export function evidenceTrailer(e: Pick<SpamPurgeEvidence, 'path' | 'field'>): string {
  return e.field ? `${e.path}#${e.field}` : e.path;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export class AgentPurgeService {
  readonly #state: InMemoryState;
  readonly #privateStore: PrivateStore;

  constructor(state: InMemoryState, privateStore: PrivateStore) {
    this.#state = state;
    this.#privateStore = privateStore;
  }

  /** The member `slug`, or 404. */
  memberOr404(slug: string): Person {
    const id = this.#state.personIdBySlug.get(slug);
    const person = id ? this.#state.people.get(id) : undefined;
    if (!person) throw new ApiNotFoundError(`Person '${slug}' not found`);
    return person;
  }

  /**
   * Every check, in the spec's order, against the current state — call it
   * inside the write mutex. Returns what the purge would delete.
   */
  async check(
    agent: Person,
    grantId: string,
    member: Person,
    body: ValidatedPurge,
    now: Date,
  ): Promise<{ projects: Project[]; deleted: PurgeDeleted }> {
    // The grant may have been revoked since the request began.
    const grant = this.#state.agentGrants.get(grantId);
    if (!grant || !isGrantActive(grant, now) || !grant.scopes.includes('moderation:purge')) {
      throw new ApiNotFoundError('Not found');
    }
    if (member.id === agent.id) throw new ApiValidationError('An agent cannot purge itself', { slug: 'self' });
    if (isAgentAccount(this.#state, member.slug)) {
      throw new ApiValidationError('Nobody purges an agent account here', { slug: 'agent' });
    }

    // The evidence: each record exists, is the member's, and is not empty.
    this.#checkEvidence(member, body);

    // 1. Only ordinary, signed-up members.
    if (member.accountLevel !== 'user' || typeof member.legacyId === 'number') {
      throw new ConflictError('Only a signed-up ordinary member can be purged by an agent', 'protected_account');
    }
    // 2. Only brand-new members.
    if (now.getTime() - Date.parse(member.createdAt) > AGENT_PURGE_MAX_AGE_DAYS * DAY_MS) {
      throw new ConflictError(
        `An agent purges only members who joined in the last ${AGENT_PURGE_MAX_AGE_DAYS} days`,
        'member_too_old',
      );
    }
    // 3. Humans are final: any human vote on this account.
    if (hasHumanVote(this.#state, member)) {
      throw new ConflictError('A person has voted on this member', 'human_verdict_exists');
    }
    // 4. No legit vote standing (any agent's, its own included).
    if (agentVotesOnAccount(this.#state, member).some((v) => v.verdict === 'legit')) {
      throw new ConflictError('An agent has voted this member not spam', 'legit_vote_exists');
    }
    // 5. Not established: signed into Slack through the site.
    const profile = await this.#privateStore.getProfile(member.id);
    if (profile?.lastSlackSsoAt) {
      throw new ConflictError('This member has signed into Slack; a person decides', 'established_member');
    }
    // 6. Nothing shared: no created project anyone else touched, no
    // maintainership of a project with another member. A plain membership of
    // someone else's project does not block.
    for (const project of projectsCreatedBy(this.#state, [member])) {
      if (isTouchedByOthers(this.#state, project, [member])) {
        throw new ConflictError(`This member created '${project.slug}', which others have touched`, 'shared_project');
      }
    }
    for (const project of this.#maintained(member)) {
      if (this.#hasOtherMember(project, member)) {
        throw new ConflictError(`This member maintains '${project.slug}', which has other members`, 'shared_project');
      }
    }
    // 7. The evidence goes with the purge.
    const projects = purgeableProjects(this.#state, [member]);
    const purgedSlugs = new Set(projects.map((p) => p.slug));
    for (const [i, e] of body.evidence.entries()) {
      if ((e.record === 'project' || e.record === 'help-wanted-role') && !purgedSlugs.has(e.input.project ?? '')) {
        throw new ConflictError(`Evidence item ${i} (${e.path}) would survive the purge`, 'evidence_survives');
      }
    }
    // 8. Volume: five purges per agent in any rolling 24 hours.
    const recent = this.#recentPurgeTimes(agent.slug, now.getTime());
    if (recent.length >= AGENT_PURGES_PER_DAY) {
      const frees = recent[recent.length - AGENT_PURGES_PER_DAY]! + DAY_MS;
      throw new RateLimitedError(Math.max(1, Math.ceil((frees - now.getTime()) / 1000)));
    }

    return { projects, deleted: this.#deletedCounts(member, projects) };
  }

  #checkEvidence(member: Person, body: ValidatedPurge): void {
    const s = this.#state;
    body.evidence.forEach((e, i) => {
      const bad = (why: string): never => {
        throw new ApiValidationError(`Evidence item ${i} (${e.path}): ${why}`, { [`evidence.${i}`]: why }, 'evidence_invalid');
      };
      const { input } = e;
      switch (e.record) {
        case 'person':
          if (!nonEmpty(member.bio)) bad('the bio is empty');
          return;
        case 'project': {
          const project = projectBySlug(s, input.project!);
          if (!project) bad('no such project');
          if (project!.createdById !== member.id) bad('not created by this member');
          const text = e.field ? (project as Record<string, unknown>)[e.field] : project!.title;
          if (!nonEmpty(text)) bad('the cited field is empty');
          return;
        }
        case 'project-update': {
          const id = s.updateByProjectAndNumber.get(projectChildKey(input.project!, input.number!));
          const update = id ? s.projectUpdates.get(id) : undefined;
          if (!update) bad('no such update');
          if (update!.authorId !== member.id) bad('not posted by this member');
          if (!nonEmpty(update!.body)) bad('the update is empty');
          return;
        }
        case 'project-buzz': {
          const id = s.buzzByProjectAndSlug.get(projectChildKey(input.project!, input.slug!));
          const buzz = id ? s.projectBuzz.get(id) : undefined;
          if (!buzz) bad('no such buzz item');
          if (buzz!.postedById !== member.id) bad('not posted by this member');
          if (!nonEmpty(buzz!.headline) && !nonEmpty(buzz!.summary)) bad('the buzz item is empty');
          return;
        }
        case 'help-wanted-role': {
          const role = s.helpWantedRoles.get(input.roleId!);
          if (!role || role.projectSlug !== input.project) bad('no such role');
          if (role!.postedById !== member.id) bad('not posted by this member');
          if (!nonEmpty(role!.title) && !nonEmpty(role!.description)) bad('the role is empty');
          return;
        }
      }
    });
  }

  /** Projects `member` maintains: by membership flag or as the project's maintainer. */
  #maintained(member: Person): Project[] {
    const out = new Map<string, Project>();
    for (const p of this.#state.projects.values()) if (p.maintainerId === member.id) out.set(p.id, p);
    for (const mid of this.#state.membershipsByPerson.get(member.slug) ?? []) {
      const m = this.#state.projectMemberships.get(mid);
      const p = m?.isMaintainer ? projectBySlug(this.#state, m.projectSlug) : undefined;
      if (p) out.set(p.id, p);
    }
    return [...out.values()];
  }

  #hasOtherMember(project: Project, member: Person): boolean {
    for (const mid of this.#state.membershipsByProject.get(project.slug) ?? []) {
      const m = this.#state.projectMemberships.get(mid);
      if (m && m.personSlug !== member.slug) return true;
    }
    return false;
  }

  #recentPurgeTimes(agentSlug: string, now: number): number[] {
    const by = agentEvaluatorFor(agentSlug);
    return [...this.#state.spamPurges.values()]
      .filter((p) => p.by === by && now - Date.parse(p.purgedAt) < DAY_MS)
      .map((p) => Date.parse(p.purgedAt))
      .sort((a, b) => a - b);
  }

  /** What a purge of `member` (with `projects`) deletes, counted. */
  #deletedCounts(member: Person, projects: readonly Project[]): PurgeDeleted {
    const s = this.#state;
    const onPurged = new Set(projects.map((p) => p.slug));
    const purgedIds = new Set(projects.map((p) => p.id));
    let memberships = 0;
    for (const m of s.projectMemberships.values()) if (m.personSlug === member.slug || onPurged.has(m.projectSlug)) memberships++;
    let updates = 0;
    for (const u of s.projectUpdates.values()) if (u.authorId === member.id || onPurged.has(u.projectSlug)) updates++;
    let buzz = 0;
    for (const b of s.projectBuzz.values()) if (b.postedById === member.id || onPurged.has(b.projectSlug)) buzz++;
    let helpWantedRoles = 0;
    for (const r of s.helpWantedRoles.values()) if (onPurged.has(r.projectSlug)) helpWantedRoles++;
    let rsvps = 0;
    for (const r of s.eventRsvps.values()) {
      if (r.personSlug === member.slug || (r.projectId && purgedIds.has(r.projectId))) rsvps++;
    }
    return {
      projects: projects.map((p) => ({ slug: p.slug, title: p.title })),
      memberships,
      updates,
      buzz,
      helpWantedRoles,
      rsvps,
    };
  }

  /** The `spam-purges` record this purge writes. */
  record(
    purgeId: string,
    agent: Person,
    grantId: string,
    member: Person,
    body: ValidatedPurge,
    beforeCommit: string,
    now: Date,
  ): SpamPurge {
    return SpamPurgeSchema.parse({
      id: purgeId,
      personSlug: member.slug,
      personId: member.id,
      ...(typeof member.githubUserId === 'number' ? { githubUserId: member.githubUserId } : {}),
      purgedAt: now.toISOString(),
      by: agentEvaluatorFor(agent.slug),
      grantId,
      reason: body.reason,
      flags: body.flags,
      evidence: body.evidence.map(({ record, field, path }) => ({ record, ...(field ? { field } : {}), path })),
      beforeCommit,
      blocksSignIn: true,
    });
  }

  /**
   * Run the purge inside `tx`: re-check everything, then the cascade, the
   * agent's `spam` vote (flags `agent`, `purged`) and the `spam-purges`
   * record, in one commit.
   */
  async purge(
    tx: DualStoreTx,
    session: SessionContext,
    member: Person,
    body: ValidatedPurge,
    purgeId: string,
    beforeCommit: () => Promise<string>,
  ): Promise<{ purge: SpamPurge; deleted: PurgeDeleted; vote: PersonEvaluation; stateApply: StateApply }> {
    const agent = session.person;
    const grantId = session.agent?.grantId;
    if (!agent || !grantId) throw new ApiNotFoundError('Not found');
    const now = new Date();
    const current = this.memberOr404(member.slug);
    if (current.id !== member.id) throw new ApiNotFoundError(`Person '${member.slug}' not found`);
    const { deleted } = await this.check(agent, grantId, current, body, now);

    const stateApply = new StateApply();
    await purgePeople(tx, this.#state, stateApply, [current]);

    const vote = PersonEvaluationSchema.parse({
      personSlug: current.slug,
      evaluator: agentEvaluatorFor(agent.slug),
      verdict: 'spam',
      flags: ['agent', 'purged', ...body.flags.filter((f) => f !== 'agent' && f !== 'purged')],
      reasoning: body.reason,
      evaluatedAt: now.toISOString(),
    });
    await tx.public['person-evaluations'].upsert(vote);
    stateApply.upsertPersonEvaluation(vote);

    const purge = this.record(purgeId, agent, grantId, current, body, await beforeCommit(), now);
    await tx.public['spam-purges'].upsert(purge);
    stateApply.upsertSpamPurge(purge);
    return { purge, deleted, vote, stateApply };
  }
}
