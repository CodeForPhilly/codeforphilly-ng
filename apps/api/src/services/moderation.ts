/**
 * Moderation: the staff members roster, per-member footprint, and human spam
 * votes. Per specs/api/moderation.md and specs/screens/admin-members.md.
 *
 * Reads come entirely from in-memory state plus the private store (email)
 * and session metadata (last sign-in). The only write is `castVote`, which
 * records a `human-<voterSlug>` person-evaluation and applies the lifecycle
 * side effect from specs/behaviors/person-lifecycle.md.
 */
import {
  PersonSchema,
  PersonEvaluationSchema,
  HUMAN_EVALUATOR_PREFIX,
  humanEvaluatorFor,
  isHumanEvaluator,
  type Person,
  type PersonEvaluation,
} from '@cfp/shared/schemas';
import type { InMemoryState } from '../store/memory/state.js';
import type { PrivateStore } from '../store/private/interface.js';
import type { DualStoreTx } from '../store/store.js';
import { StateApply } from '../store/state-apply.js';
import type { SessionContext } from '../auth/middleware.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { githubFactsFrom, type GitHubProbeResult } from '../auth/github-client.js';

export type VoteVerdict = 'spam' | 'legit';
export type VoteFilter = 'none' | VoteVerdict;

export interface MemberListOptions {
  readonly q?: string;
  readonly vote?: VoteFilter;
  readonly origin?: MemberOrigin;
  readonly joinedAfter?: string;
  readonly joinedBefore?: string;
  readonly includeDeactivated?: boolean;
  readonly sort?: string;
  readonly page?: number;
  readonly perPage?: number;
}

export interface VoterRef {
  readonly slug: string;
  readonly fullName: string;
}

export interface VoteView {
  readonly verdict: 'spam' | 'legit' | 'uncertain';
  readonly reasoning: string | null;
  readonly voter: VoterRef;
  readonly evaluatedAt: string;
}

export interface FootprintCounts {
  readonly memberships: number;
  readonly updates: number;
  readonly buzz: number;
  readonly blogPosts: number;
  readonly helpWantedInterest: number;
  readonly tags: number;
}

export type MemberOrigin = 'imported' | 'signed-up';

export interface MemberGitHub {
  readonly login: string | null;
  readonly accountCreatedAt: string | null;
  readonly publicRepos: number | null;
  readonly followers: number | null;
  readonly status: 'ok' | 'gone' | 'unknown';
  readonly checkedAt: string | null;
}

export interface MemberRow {
  readonly id: string;
  readonly slug: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly createdAt: string;
  readonly deletedAt: string | null;
  /** Imported from laddr (has a legacyId) or signed up on this site through GitHub. */
  readonly origin: MemberOrigin;
  readonly email: string | null;
  readonly hasGitHubLink: boolean;
  readonly github: MemberGitHub | null;
  readonly lastLoginAt: string | null;
  readonly signInCount: number;
  readonly lastSlackSsoAt: string | null;
  readonly emailBounce: { readonly type: string; readonly bouncedAt: string } | null;
  readonly bioExcerpt: string;
  readonly footprint: FootprintCounts;
  readonly latestVote: VoteView | null;
  /** Row-local facts worth a glance; see `computeSignals`. */
  readonly signals: string[];
  /** Number of negative signals — drives the roster's attention tint. */
  readonly attention: number;
}

export interface ProjectRef {
  readonly slug: string;
  readonly title: string;
}

export interface MemberFootprint {
  readonly memberships: Array<{ project: ProjectRef; role: string; joinedAt: string }>;
  readonly updates: Array<{ project: ProjectRef; number: number; title: string; postedAt: string }>;
  readonly buzz: Array<{ project: ProjectRef; slug: string; title: string; postedAt: string }>;
  readonly blogPosts: Array<{ slug: string; title: string; postedAt: string }>;
  readonly helpWantedInterest: Array<{ project: ProjectRef; role: { title: string }; createdAt: string }>;
  readonly tags: Array<{ handle: string; type: string }>;
}

interface AuthoredCounts {
  updates: Map<string, number>;
  buzz: Map<string, number>;
  blogPosts: Map<string, number>;
  interest: Map<string, number>;
}

export interface MemberListResult {
  readonly items: MemberRow[];
  readonly totalItems: number;
  readonly page: number;
  readonly perPage: number;
}

/** Sign-in facts for a person from session metadata; injected to avoid a plugin dependency. */
export type SessionLookup = (personId: string) => { lastLoginAt: string | null; count: number };

/**
 * Asks GitHub whether a linked account still exists. Injected so tests and
 * deployments without an OAuth app never touch the network.
 */
export type GitHubProbe = (githubUserId: number) => Promise<GitHubProbeResult>;

/** How old a `github` record may be before the roster re-probes it. */
const GITHUB_PROBE_TTL_MS = 24 * 60 * 60 * 1000;
const GITHUB_PROBE_CONCURRENCY = 5;
const GITHUB_NEW_ACCOUNT_DAYS = 30;

const SORT_KEYS = new Set(['createdAt', 'fullName', 'lastLoginAt']);

const EMAIL_TOKEN_MIN = 3;

/**
 * Does the email's local part share a recognisable token with the display
 * name? `stacey.villarreal@` vs "Stacey Villarreal" → true; `benjamin_cox8mzr@`
 * vs "Stacey Villarreal" → false. Names shorter than three letters are ignored
 * to avoid false matches on initials.
 */
export function emailMatchesName(email: string | null, fullName: string): boolean | null {
  if (!email) return null;
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  const tokens = fullName
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= EMAIL_TOKEN_MIN);
  if (!local || tokens.length === 0) return null;
  return tokens.some((t) => local.includes(t));
}

export function countLinks(bio: string | null | undefined): number {
  if (!bio) return 0;
  return (bio.match(/https?:\/\/|www\.|\]\(|<a\s/gi) ?? []).length;
}

/**
 * Row-local signals. Negative ones (the spam shape) count toward `attention`;
 * positive ones are informational. None of this consults the machine
 * evaluators — it is what a careful reader would notice on the row.
 */
export function computeSignals(input: {
  readonly person: Person;
  readonly email: string | null;
  readonly signInCount: number;
  readonly github: MemberGitHub | null;
  readonly emailBounce: { type: string } | null;
  readonly lastSlackSsoAt: string | null;
  readonly footprint: FootprintCounts;
}): { signals: string[]; attention: number } {
  const { person } = input;
  const signals: string[] = [];
  let attention = 0;
  const negative = (s: string): void => {
    signals.push(s);
    attention += 1;
  };

  if (input.signInCount === 0) negative('never-signed-in');
  if (!person.avatarKey) negative('no-avatar');
  if (!person.bio || person.bio.trim() === '') negative('no-bio');
  const links = countLinks(person.bio);
  if (links > 0) negative(`bio-links:${links}`);
  if (emailMatchesName(input.email, person.fullName) === false) negative('email-name-mismatch');
  if (input.emailBounce) negative(`email-bounced:${input.emailBounce.type}`);
  if (input.github) {
    if (input.github.status === 'gone') negative('github-gone');
    if (input.github.accountCreatedAt) {
      const ageDays = (Date.now() - Date.parse(input.github.accountCreatedAt)) / 86_400_000;
      if (ageDays < GITHUB_NEW_ACCOUNT_DAYS) negative('github-new-account');
    }
    if ((input.github.publicRepos ?? 0) === 0 && (input.github.followers ?? 0) === 0) {
      negative('github-no-activity');
    }
  }
  if (input.lastSlackSsoAt) signals.push('slack-sso');
  const fp = input.footprint;
  if (fp.memberships + fp.updates + fp.buzz + fp.blogPosts + fp.helpWantedInterest > 0) signals.push('has-footprint');
  return { signals, attention };
}

function parseSort(sort: string | undefined): { key: string; desc: boolean } | null {
  const raw = sort && sort.trim() !== '' ? sort.trim() : '-createdAt';
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  if (!SORT_KEYS.has(key)) return null;
  return { key, desc };
}

/** Strip the markdown a bio typically carries and cut to ~160 chars. */
export function bioExcerpt(bio: string | null | undefined, max = 160): string {
  if (!bio) return '';
  const text = bio
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class ModerationService {
  readonly #state: InMemoryState;
  readonly #privateStore: PrivateStore;
  readonly #sessions: SessionLookup;
  readonly #probe: GitHubProbe | null;
  readonly #log: { warn(obj: unknown, msg: string): void } | null;

  constructor(
    state: InMemoryState,
    privateStore: PrivateStore,
    sessions: SessionLookup,
    opts: { readonly probe?: GitHubProbe; readonly log?: { warn(obj: unknown, msg: string): void } } = {},
  ) {
    this.#state = state;
    this.#privateStore = privateStore;
    this.#sessions = sessions;
    this.#probe = opts.probe ?? null;
    this.#log = opts.log ?? null;
  }

  /**
   * Refresh stale `github` records for the given people (bounded concurrency,
   * best-effort). A probe failure keeps the old record; a 404 marks it gone.
   */
  async refreshGitHubFacts(people: readonly Person[]): Promise<void> {
    if (!this.#probe) return;
    const cutoff = Date.now() - GITHUB_PROBE_TTL_MS;
    const stale: Person[] = [];
    for (const p of people) {
      if (typeof p.githubUserId !== 'number') continue;
      const profile = await this.#privateStore.getProfile(p.id);
      const checked = profile?.github?.checkedAt ? Date.parse(profile.github.checkedAt) : 0;
      if (checked < cutoff) stale.push(p);
    }
    const queue = [...stale];
    const worker = async (): Promise<void> => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        try {
          const result = await this.#probe!(p.githubUserId as number);
          const profile = await this.#privateStore.getProfile(p.id);
          if (!profile) continue;
          const now = new Date().toISOString();
          const previous = profile.github ?? null;
          const github =
            result.status === 'ok' && result.user
              ? githubFactsFrom(result.user, 'ok', now)
              : {
                  login: previous?.login ?? p.githubLogin ?? '',
                  accountCreatedAt: previous?.accountCreatedAt ?? null,
                  publicRepos: previous?.publicRepos ?? null,
                  followers: previous?.followers ?? null,
                  following: previous?.following ?? null,
                  type: previous?.type ?? null,
                  status: 'gone' as const,
                  checkedAt: now,
                };
          await this.#privateStore.putProfile({ ...profile, github, updatedAt: now });
        } catch (err) {
          this.#log?.warn({ err, personId: p.id }, 'github probe failed; keeping previous record');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(GITHUB_PROBE_CONCURRENCY, queue.length) }, worker));
  }

  /** Every human vote on a person, newest first. */
  humanVotes(personSlug: string): VoteView[] {
    const keys = this.#state.evaluationsByPerson.get(personSlug);
    if (!keys) return [];
    const votes: VoteView[] = [];
    for (const key of keys) {
      const rec = this.#state.personEvaluations.get(key);
      if (!rec || !isHumanEvaluator(rec.evaluator)) continue;
      votes.push(this.#voteView(rec));
    }
    return votes.sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
  }

  latestHumanVote(personSlug: string): VoteView | null {
    return this.humanVotes(personSlug)[0] ?? null;
  }

  async listMembers(opts: MemberListOptions): Promise<MemberListResult | { error: 'invalid_sort' }> {
    const sort = parseSort(opts.sort);
    if (!sort) return { error: 'invalid_sort' };

    const includeDeactivated = opts.includeDeactivated ?? true;
    const q = opts.q?.trim().toLowerCase() ?? '';

    let people = [...this.#state.people.values()];
    if (!includeDeactivated) people = people.filter((p) => !p.deletedAt);
    if (opts.origin) {
      people = people.filter(
        (p) => (typeof p.legacyId === 'number' ? 'imported' : 'signed-up') === opts.origin,
      );
    }
    if (opts.joinedAfter) people = people.filter((p) => p.createdAt >= opts.joinedAfter!);
    if (opts.joinedBefore) people = people.filter((p) => p.createdAt <= opts.joinedBefore!);
    if (opts.vote) {
      people = people.filter((p) => {
        const latest = this.latestHumanVote(p.slug);
        if (opts.vote === 'none') return latest === null;
        return latest?.verdict === opts.vote;
      });
    }

    const authored = this.#authoredCounts();
    const lastLogins = new Map<string, { lastLoginAt: string | null; count: number }>();
    const emails = new Map<string, string | null>();
    const emailOf = async (p: Person): Promise<string | null> => {
      if (!emails.has(p.id)) emails.set(p.id, (await this.#privateStore.getProfile(p.id))?.email ?? null);
      return emails.get(p.id) ?? null;
    };

    if (q) {
      const matched: Person[] = [];
      for (const p of people) {
        const hay = `${p.fullName} ${p.slug} ${p.bio ?? ''}`.toLowerCase();
        if (hay.includes(q)) {
          matched.push(p);
          continue;
        }
        // Email is searched for any query, not just ones with an "@" — a bare
        // domain or local-part substring is the common case when triaging.
        const email = await emailOf(p);
        if (email && email.toLowerCase().includes(q)) matched.push(p);
      }
      people = matched;
    }

    const sessionsOf = (p: Person): { lastLoginAt: string | null; count: number } => {
      if (!lastLogins.has(p.id)) lastLogins.set(p.id, this.#sessions(p.id));
      return lastLogins.get(p.id)!;
    };
    const lastLoginOf = (p: Person): string | null => sessionsOf(p).lastLoginAt;

    people.sort((a, b) => {
      let cmp: number;
      if (sort.key === 'fullName') cmp = a.fullName.localeCompare(b.fullName);
      else if (sort.key === 'lastLoginAt') cmp = (lastLoginOf(a) ?? '').localeCompare(lastLoginOf(b) ?? '');
      else cmp = a.createdAt.localeCompare(b.createdAt);
      if (cmp === 0) cmp = a.slug.localeCompare(b.slug);
      return sort.desc ? -cmp : cmp;
    });

    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(200, Math.max(1, opts.perPage ?? 50));
    const slice = people.slice((page - 1) * perPage, page * perPage);

    // Only the rows on this page get a (possibly stale) GitHub re-check.
    await this.refreshGitHubFacts(slice);

    const items: MemberRow[] = [];
    for (const p of slice) items.push(await this.#row(p, authored, sessionsOf(p)));

    return { items, totalItems: people.length, page, perPage };
  }

  /** The roster row for one person (used by the list and the detail endpoint). */
  async memberRow(slug: string): Promise<MemberRow | null> {
    const id = this.#state.personIdBySlug.get(slug);
    const person = id ? this.#state.people.get(id) : undefined;
    if (!person) return null;
    await this.refreshGitHubFacts([person]);
    return this.#row(person, this.#authoredCounts(), this.#sessions(person.id));
  }

  async #row(
    p: Person,
    authored: AuthoredCounts,
    sessions: { lastLoginAt: string | null; count: number },
  ): Promise<MemberRow> {
    const profile = await this.#privateStore.getProfile(p.id);
    const github: MemberGitHub | null =
      typeof p.githubUserId === 'number'
        ? {
            login: profile?.github?.login ?? p.githubLogin ?? null,
            accountCreatedAt: profile?.github?.accountCreatedAt ?? null,
            publicRepos: profile?.github?.publicRepos ?? null,
            followers: profile?.github?.followers ?? null,
            status: profile?.github?.status ?? 'unknown',
            checkedAt: profile?.github?.checkedAt ?? null,
          }
        : null;
    const emailBounce = profile?.emailBounce
      ? { type: profile.emailBounce.type, bouncedAt: profile.emailBounce.bouncedAt }
      : null;
    const footprint: FootprintCounts = {
      memberships: this.#state.membershipsByPerson.get(p.id)?.size ?? 0,
      updates: authored.updates.get(p.id) ?? 0,
      buzz: authored.buzz.get(p.id) ?? 0,
      blogPosts: authored.blogPosts.get(p.id) ?? 0,
      helpWantedInterest: authored.interest.get(p.id) ?? 0,
      tags: this.#state.tagAssignmentsByTaggable.get(p.id)?.size ?? 0,
    };
    const email = profile?.email ?? null;
    const lastSlackSsoAt = profile?.lastSlackSsoAt ?? null;
    const { signals, attention } = computeSignals({
      person: p,
      email,
      signInCount: sessions.count,
      github,
      emailBounce,
      lastSlackSsoAt,
      footprint,
    });
    return {
      id: p.id,
      slug: p.slug,
      fullName: p.fullName,
      avatarUrl: p.avatarKey ? `/api/attachments/${p.avatarKey}` : null,
      createdAt: p.createdAt,
      deletedAt: p.deletedAt ?? null,
      origin: typeof p.legacyId === 'number' ? 'imported' : 'signed-up',
      email,
      hasGitHubLink: typeof p.githubUserId === 'number',
      github,
      lastLoginAt: sessions.lastLoginAt,
      signInCount: sessions.count,
      lastSlackSsoAt,
      emailBounce,
      bioExcerpt: bioExcerpt(p.bio),
      footprint,
      latestVote: this.latestHumanVote(p.slug),
      signals,
      attention,
    };
  }

  /** Full footprint for one member (deactivated included — this is moderation). */
  footprint(slug: string): MemberFootprint | null {
    const id = this.#state.personIdBySlug.get(slug);
    if (!id) return null;
    const s = this.#state;
    const projectRef = (projectId: string): ProjectRef | null => {
      const project = s.projects.get(projectId);
      return project ? { slug: project.slug, title: project.title } : null;
    };

    const memberships = [...(s.membershipsByPerson.get(id) ?? [])]
      .map((mid) => s.projectMemberships.get(mid))
      .flatMap((m) => {
        const project = m ? projectRef(m.projectId) : null;
        return m && project ? [{ project, role: m.role ?? (m.isMaintainer ? 'maintainer' : 'member'), joinedAt: m.joinedAt }] : [];
      });

    const updates = [...s.projectUpdates.values()]
      .filter((u) => u.authorId === id)
      .flatMap((u) => {
        const project = projectRef(u.projectId);
        // Updates have no title; the excerpt of the body stands in for one.
        return project ? [{ project, number: u.number, title: bioExcerpt(u.body, 80), postedAt: u.createdAt }] : [];
      })
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

    const buzz = [...s.projectBuzz.values()]
      .filter((b) => b.postedById === id)
      .flatMap((b) => {
        const project = projectRef(b.projectId);
        return project ? [{ project, slug: b.slug, title: b.headline, postedAt: b.publishedAt }] : [];
      })
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

    const blogPosts = [...s.blogPosts.values()]
      .filter((bp) => bp.authorId === id)
      .map((bp) => ({ slug: bp.slug, title: bp.title, postedAt: bp.postedAt }))
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

    const helpWantedInterest = [...s.helpWantedInterest.values()]
      .filter((i) => i.personId === id)
      .flatMap((i) => {
        const role = s.helpWantedRoles.get(i.roleId);
        const project = role ? projectRef(role.projectId) : null;
        return role && project ? [{ project, role: { title: role.title }, createdAt: i.createdAt }] : [];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const tags = [...(s.tagAssignmentsByTaggable.get(id) ?? [])]
      .map((taId) => s.tagAssignments.get(taId))
      .flatMap((ta) => {
        const tag = ta ? s.tags.get(ta.tagId) : undefined;
        return tag ? [{ handle: `${tag.namespace}.${tag.slug}`, type: tag.namespace }] : [];
      });

    return { memberships, updates, buzz, blogPosts, helpWantedInterest, tags };
  }

  #voteView(rec: PersonEvaluation): VoteView {
    const voterSlug = rec.evaluator.slice(HUMAN_EVALUATOR_PREFIX.length);
    const voterId = this.#state.personIdBySlug.get(voterSlug);
    const voter = voterId ? this.#state.people.get(voterId) : undefined;
    return {
      verdict: rec.verdict,
      reasoning: rec.reasoning ?? null,
      voter: { slug: voterSlug, fullName: voter?.fullName ?? voterSlug },
      evaluatedAt: rec.evaluatedAt,
    };
  }

  #authoredCounts(): AuthoredCounts {
    const bump = (m: Map<string, number>, k: string | null | undefined): void => {
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    };
    const updates = new Map<string, number>();
    const buzz = new Map<string, number>();
    const blogPosts = new Map<string, number>();
    const interest = new Map<string, number>();
    for (const u of this.#state.projectUpdates.values()) bump(updates, u.authorId);
    for (const b of this.#state.projectBuzz.values()) bump(buzz, b.postedById);
    for (const bp of this.#state.blogPosts.values()) bump(blogPosts, bp.authorId);
    for (const i of this.#state.helpWantedInterest.values()) bump(interest, i.personId);
    return { updates, buzz, blogPosts, interest };
  }
}

export interface CastVoteInput {
  readonly verdict: VoteVerdict;
  readonly reasoning?: string;
}

export class ModerationWriteService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  /**
   * Record the caller's verdict as `person-evaluations/<slug>/human-<caller>`
   * and apply the lifecycle side effect: spam → deactivate; legit → reactivate
   * only when the previous latest human vote was spam (a self-deactivation is
   * never undone by a vote). One record per voter; re-voting replaces it.
   */
  async castVote(
    tx: DualStoreTx,
    slug: string,
    session: SessionContext,
    input: CastVoteInput,
  ): Promise<{ person: Person; vote: PersonEvaluation; stateApply: StateApply }> {
    const voter = session.person;
    if (!voter) throw new ApiNotFoundError(`Person '${slug}' not found`);

    const id = this.#state.personIdBySlug.get(slug);
    const existing = id ? this.#state.people.get(id) : undefined;
    if (!existing) throw new ApiNotFoundError(`Person '${slug}' not found`);
    if (existing.id === voter.id) {
      throw new ApiValidationError('You cannot vote on your own account', { slug: 'self' });
    }
    if (input.reasoning !== undefined && input.reasoning.length > 1000) {
      throw new ApiValidationError('Reasoning is too long', { reasoning: 'max 1000 characters' });
    }

    const previousLatest = latestHumanVerdict(this.#state, slug);
    const now = nowIso();
    const vote: PersonEvaluation = PersonEvaluationSchema.parse({
      personSlug: slug,
      evaluator: humanEvaluatorFor(voter.slug),
      verdict: input.verdict,
      confidence: 1,
      flags: ['manual-override'],
      ...(input.reasoning && input.reasoning.trim() !== '' ? { reasoning: input.reasoning.trim() } : {}),
      evaluatedAt: now,
    });

    await tx.public['person-evaluations'].upsert(vote);
    const stateApply = new StateApply().upsertPersonEvaluation(vote);

    let person = existing;
    if (input.verdict === 'spam' && !existing.deletedAt) {
      person = PersonSchema.parse({ ...existing, deletedAt: now, updatedAt: now });
    } else if (input.verdict === 'legit' && existing.deletedAt && previousLatest === 'spam') {
      person = PersonSchema.parse({ ...existing, deletedAt: null, updatedAt: now });
    }
    if (person !== existing) {
      await tx.public.people.upsert(person);
      stateApply.upsertPerson(person);
    }

    return { person, vote, stateApply };
  }
}

function latestHumanVerdict(state: InMemoryState, personSlug: string): PersonEvaluation['verdict'] | null {
  const keys = state.evaluationsByPerson.get(personSlug);
  if (!keys) return null;
  let latest: PersonEvaluation | null = null;
  for (const key of keys) {
    const rec = state.personEvaluations.get(key);
    if (!rec || !isHumanEvaluator(rec.evaluator)) continue;
    if (!latest || rec.evaluatedAt > latest.evaluatedAt) latest = rec;
  }
  return latest?.verdict ?? null;
}
