/**
 * Moderation: the staff members roster, per-member footprint, and spam votes
 * by staff and by agents. Per specs/api/moderation.md and
 * specs/screens/admin-members.md.
 *
 * Reads come entirely from in-memory state plus the private store (email)
 * and session metadata (last sign-in). The writes record a
 * `human-<voterSlug>` or `agent-<agentSlug>` person-evaluation and apply the
 * lifecycle side effect from specs/behaviors/person-lifecycle.md; an agent's
 * vote is staged and fenced by the rules in moderation.md → Agent votes.
 */
import { spamPurgeDueAt } from './spam-purge.js';
import {
  agentVotesOnAccount,
  hasHumanVote,
  humanVotesOnAccount,
  newestVote,
  stagedAgentVote,
  votesOnAccount,
  votesOnEarlierAccounts,
} from './votes.js';
import {
  PersonSchema,
  PersonEvaluationSchema,
  agentEvaluatorFor,
  evaluatorKind,
  evaluatorSlug,
  humanEvaluatorFor,
  type EvaluatorKind,
  type Person,
  type PersonEvaluation,
  type SpamPurge,
} from '@cfp/shared/schemas';
import { agentHasActiveGrant, isAgentAccount, isGrantActive } from '../auth/agent-grant.js';
import { projectBySlug, type InMemoryState } from '../store/memory/state.js';
import type { PrivateStore } from '../store/private/interface.js';
import type { DualStoreTx } from '../store/store.js';
import { StateApply } from '../store/state-apply.js';
import type { SessionContext } from '../auth/middleware.js';
import { ApiNotFoundError, ApiValidationError, ConflictError, RateLimitedError } from '../lib/errors.js';
import { githubFactsFrom, type GitHubProbeResult } from '../auth/github-client.js';

export type VoteVerdict = 'spam' | 'legit';
export type VoteFilter = 'none' | 'staged' | VoteVerdict;

/** Who is reading the roster: agents see email domains only (moderation.md → Agent callers). */
export type RosterViewer = 'staff' | 'agent';

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
  readonly viewer?: RosterViewer;
}

export interface VoterRef {
  readonly slug: string;
  readonly fullName: string;
}

export interface VoteView {
  /** From the evaluator's prefix: a staff member's vote or an agent's. */
  readonly kind: EvaluatorKind;
  readonly verdict: 'spam' | 'legit' | 'uncertain';
  readonly reasoning: string | null;
  /** Reason tags, less the `manual-override` / `agent` markers. */
  readonly flags: string[];
  readonly voter: VoterRef;
  readonly evaluatedAt: string;
}

/** The newest agent vote when no human has voted (moderation.md → stagedVote). */
export interface StagedVoteView {
  readonly verdict: 'spam' | 'legit' | 'uncertain';
  readonly agent: VoterRef;
  readonly reasoning: string | null;
  readonly flags: string[];
  readonly evaluatedAt: string;
  /** False once the agent holds no active grant: the vote no longer queues a purge. */
  readonly counts: boolean;
}

/** A spam-purge record as the detail's `earlierPurges` lists it. */
export interface EarlierPurgeView {
  readonly id: string;
  readonly purgedAt: string;
  readonly by: string;
  readonly reason: string | null;
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
  /** Always null for an agent caller. */
  readonly email: string | null;
  readonly emailDomain: string | null;
  readonly hasGitHubLink: boolean;
  readonly github: MemberGitHub | null;
  readonly lastLoginAt: string | null;
  readonly signInCount: number;
  readonly lastSlackSsoAt: string | null;
  readonly emailBounce: { readonly type: string; readonly bouncedAt: string } | null;
  readonly bioExcerpt: string;
  readonly footprint: FootprintCounts;
  /** The latest human vote on this account; never an agent's. */
  readonly latestVote: VoteView | null;
  readonly stagedVote: StagedVoteView | null;
  /** Whether this is an agent account (nobody votes on it). */
  readonly isAgent: boolean;
  /** When the scheduled spam purge will take this member, or null (specs/behaviors/person-lifecycle.md). */
  readonly purgeAfter: string | null;
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
  /** Keyed by person slug (interest references people by slug); the rest by person id. */
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
  /** A spam-purges record names this slug: an earlier account under it was purged as spam. */
  readonly slugPurgedBefore?: boolean;
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
  if (input.slugPurgedBefore) negative('slug-purged-before');
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

/** The part of an email after the `@`, lowercased, or null. */
export function emailDomainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at >= 0 && at < email.length - 1 ? email.slice(at + 1).toLowerCase() : null;
}

/** Flags shown with a vote: the stored ones less the kind markers. */
function shownFlags(rec: PersonEvaluation): string[] {
  return rec.flags.filter((f) => f !== 'agent' && f !== 'manual-override');
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

  /**
   * Every vote on this person's account — staff and agent — newest first.
   * Votes on an earlier account under the same slug are not theirs
   * (`earlierVotes`).
   */
  votes(personSlug: string): VoteView[] {
    const person = this.#person(personSlug);
    if (!person) return [];
    return this.#views(votesOnAccount(this.#state, person).filter((r) => evaluatorKind(r.evaluator) !== 'machine'));
  }

  /** Every human vote on this person's account, newest first. */
  humanVotes(personSlug: string): VoteView[] {
    const person = this.#person(personSlug);
    if (!person) return [];
    return this.#views(humanVotesOnAccount(this.#state, person));
  }

  latestHumanVote(personSlug: string): VoteView | null {
    return this.humanVotes(personSlug)[0] ?? null;
  }

  /** Votes cast on an earlier account under this slug, newest first. */
  earlierVotes(personSlug: string): VoteView[] {
    const person = this.#person(personSlug);
    if (!person) return [];
    return this.#views(
      votesOnEarlierAccounts(this.#state, person).filter((r) => evaluatorKind(r.evaluator) !== 'machine'),
    );
  }

  /** The `spam-purges` records for this slug, newest first. */
  earlierPurges(personSlug: string): EarlierPurgeView[] {
    return [...(this.#state.spamPurgesBySlug.get(personSlug) ?? [])]
      .map((id) => this.#state.spamPurges.get(id))
      .filter((p): p is SpamPurge => p !== undefined)
      .sort((a, b) => b.purgedAt.localeCompare(a.purgedAt))
      .map((p) => ({ id: p.id, purgedAt: p.purgedAt, by: p.by, reason: p.reason ?? null }));
  }

  /** The roster's `stagedVote` for one person, or null. */
  stagedVote(personSlug: string, now: Date = new Date()): StagedVoteView | null {
    const person = this.#person(personSlug);
    if (!person) return null;
    const rec = stagedAgentVote(this.#state, person);
    if (!rec) return null;
    const agentSlug = evaluatorSlug(rec.evaluator) ?? rec.evaluator;
    return {
      verdict: rec.verdict,
      agent: this.#voterRef(agentSlug),
      reasoning: rec.reasoning ?? null,
      flags: shownFlags(rec),
      evaluatedAt: rec.evaluatedAt,
      counts: agentHasActiveGrant(this.#state, agentSlug, now),
    };
  }

  #person(slug: string): Person | undefined {
    const id = this.#state.personIdBySlug.get(slug);
    return id ? this.#state.people.get(id) : undefined;
  }

  #voterRef(slug: string): VoterRef {
    return { slug, fullName: this.#person(slug)?.fullName ?? slug };
  }

  #views(records: readonly PersonEvaluation[]): VoteView[] {
    return records.map((r) => this.#voteView(r)).sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
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
        if (opts.vote === 'none') return !hasHumanVote(this.#state, p);
        if (opts.vote === 'staged') return stagedAgentVote(this.#state, p) !== null;
        return newestVote(humanVotesOnAccount(this.#state, p))?.verdict === opts.vote;
      });
    }
    const viewer: RosterViewer = opts.viewer ?? 'staff';

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
        // An agent searches the domain only (moderation.md → Agent callers).
        const email = await emailOf(p);
        const searchable = viewer === 'agent' ? emailDomainOf(email) : email?.toLowerCase();
        if (searchable && searchable.includes(q)) matched.push(p);
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
    for (const p of slice) items.push(await this.#row(p, authored, sessionsOf(p), viewer));

    return { items, totalItems: people.length, page, perPage };
  }

  /** The roster row for one person (used by the list and the detail endpoint). */
  async memberRow(slug: string, viewer: RosterViewer = 'staff'): Promise<MemberRow | null> {
    const id = this.#state.personIdBySlug.get(slug);
    const person = id ? this.#state.people.get(id) : undefined;
    if (!person) return null;
    await this.refreshGitHubFacts([person]);
    return this.#row(person, this.#authoredCounts(), this.#sessions(person.id), viewer);
  }

  async #row(
    p: Person,
    authored: AuthoredCounts,
    sessions: { lastLoginAt: string | null; count: number },
    viewer: RosterViewer = 'staff',
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
      memberships: this.#state.membershipsByPerson.get(p.slug)?.size ?? 0,
      updates: authored.updates.get(p.id) ?? 0,
      buzz: authored.buzz.get(p.id) ?? 0,
      blogPosts: authored.blogPosts.get(p.id) ?? 0,
      helpWantedInterest: authored.interest.get(p.slug) ?? 0,
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
      slugPurgedBefore: (this.#state.spamPurgesBySlug.get(p.slug)?.size ?? 0) > 0,
    });
    return {
      id: p.id,
      slug: p.slug,
      fullName: p.fullName,
      avatarUrl: p.avatarKey ? `/api/attachments/${p.avatarKey}` : null,
      createdAt: p.createdAt,
      deletedAt: p.deletedAt ?? null,
      origin: typeof p.legacyId === 'number' ? 'imported' : 'signed-up',
      email: viewer === 'agent' ? null : email,
      emailDomain: emailDomainOf(email),
      hasGitHubLink: typeof p.githubUserId === 'number',
      github,
      lastLoginAt: sessions.lastLoginAt,
      signInCount: sessions.count,
      lastSlackSsoAt,
      emailBounce,
      bioExcerpt: bioExcerpt(p.bio),
      footprint,
      latestVote: this.latestHumanVote(p.slug),
      stagedVote: this.stagedVote(p.slug),
      isAgent: isAgentAccount(this.#state, p.slug),
      purgeAfter: spamPurgeDueAt(this.#state, p)?.toISOString() ?? null,
      signals,
      attention,
    };
  }

  /** Full footprint for one member (deactivated included — this is moderation). */
  footprint(slug: string): MemberFootprint | null {
    const id = this.#state.personIdBySlug.get(slug);
    if (!id) return null;
    const s = this.#state;
    const projectRef = (projectSlug: string): ProjectRef | null => {
      const project = projectBySlug(s, projectSlug);
      return project ? { slug: project.slug, title: project.title } : null;
    };

    const memberships = [...(s.membershipsByPerson.get(slug) ?? [])]
      .map((mid) => s.projectMemberships.get(mid))
      .flatMap((m) => {
        const project = m ? projectRef(m.projectSlug) : null;
        return m && project ? [{ project, role: m.role ?? (m.isMaintainer ? 'maintainer' : 'member'), joinedAt: m.joinedAt }] : [];
      });

    const updates = [...s.projectUpdates.values()]
      .filter((u) => u.authorId === id)
      .flatMap((u) => {
        const project = projectRef(u.projectSlug);
        // Updates have no title; the excerpt of the body stands in for one.
        return project ? [{ project, number: u.number, title: bioExcerpt(u.body, 80), postedAt: u.createdAt }] : [];
      })
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

    const buzz = [...s.projectBuzz.values()]
      .filter((b) => b.postedById === id)
      .flatMap((b) => {
        const project = projectRef(b.projectSlug);
        return project ? [{ project, slug: b.slug, title: b.headline, postedAt: b.publishedAt }] : [];
      })
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

    const blogPosts = [...s.blogPosts.values()]
      .filter((bp) => bp.authorId === id)
      .map((bp) => ({ slug: bp.slug, title: bp.title, postedAt: bp.postedAt }))
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

    const helpWantedInterest = [...s.helpWantedInterest.values()]
      .filter((i) => i.personSlug === slug)
      .flatMap((i) => {
        const role = s.helpWantedRoles.get(i.roleId);
        const project = role ? projectRef(role.projectSlug) : null;
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
    const voterSlug = evaluatorSlug(rec.evaluator) ?? rec.evaluator;
    return {
      kind: evaluatorKind(rec.evaluator),
      verdict: rec.verdict,
      reasoning: rec.reasoning ?? null,
      flags: shownFlags(rec),
      voter: this.#voterRef(voterSlug),
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
    for (const i of this.#state.helpWantedInterest.values()) bump(interest, i.personSlug);
    return { updates, buzz, blogPosts, interest };
  }
}

export interface CastVoteInput {
  readonly verdict: VoteVerdict;
  readonly reasoning?: string;
  /** Agents only: 0–10 reason tags. */
  readonly flags?: readonly string[];
}

/** Agent vote limits — specs/api/moderation.md → Agent votes. */
export const AGENT_SPAM_VOTES_PER_DAY = 20;
export const AGENT_SPAM_VOTE_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const FLAG_RE = /^[a-z0-9][a-z0-9:-]{0,39}$/;

/** Validate an agent's reason tags (votes and purges): 0–10, each `^[a-z0-9][a-z0-9:-]{0,39}$`. */
export function validateFlags(flags: readonly string[] | undefined): string[] {
  const list = flags ?? [];
  if (!Array.isArray(list) || list.length > 10 || list.some((f) => typeof f !== 'string' || !FLAG_RE.test(f))) {
    throw new ApiValidationError('Invalid flags', { flags: '0–10 tags matching ^[a-z0-9][a-z0-9:-]{0,39}$' });
  }
  return [...new Set(list)];
}

/** The reversal rule: was the latest vote on this account (human or agent) `spam`? */
function latestVoteWasSpam(state: InMemoryState, person: Person): boolean {
  return newestVote(votesOnAccount(state, person).filter((v) => evaluatorKind(v.evaluator) !== 'machine'))?.verdict === 'spam';
}

export class ModerationWriteService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  #personOr404(slug: string): Person {
    const id = this.#state.personIdBySlug.get(slug);
    const person = id ? this.#state.people.get(id) : undefined;
    if (!person) throw new ApiNotFoundError(`Person '${slug}' not found`);
    return person;
  }

  /**
   * The agent behind `session`, re-checked inside the write mutex: a grant
   * revoked since the request began stops here.
   */
  #agentOf(session: SessionContext): Person {
    const agent = session.person;
    const grant = session.agent ? this.#state.agentGrants.get(session.agent.grantId) : undefined;
    if (!agent || !grant || !isGrantActive(grant)) throw new ApiNotFoundError('Not found');
    return agent;
  }

  /**
   * Record the caller's verdict as `person-evaluations/<slug>/<evaluator>`
   * and apply the lifecycle side effect: spam → deactivate; legit →
   * reactivate only when the previous latest vote on the account (human or
   * agent) was spam (a self-deactivation is never undone by a vote). One
   * record per voter; re-voting replaces it.
   *
   * Staff votes are `human-<slug>`, final. An agent session's votes are
   * `agent-<slug>`, staged, and fenced by the agent vote rules, checked here
   * inside the write mutex.
   */
  async castVote(
    tx: DualStoreTx,
    slug: string,
    session: SessionContext,
    input: CastVoteInput,
  ): Promise<{ person: Person; vote: PersonEvaluation; stateApply: StateApply }> {
    const voter = session.person;
    if (!voter) throw new ApiNotFoundError(`Person '${slug}' not found`);
    if (session.agent) this.#agentOf(session);

    const existing = this.#personOr404(slug);
    if (existing.id === voter.id) {
      throw new ApiValidationError('You cannot vote on your own account', { slug: 'self' });
    }
    if (isAgentAccount(this.#state, existing.slug)) {
      throw new ApiValidationError('Nobody votes on an agent account', { slug: 'agent' });
    }
    if (input.reasoning !== undefined && input.reasoning.length > 1000) {
      throw new ApiValidationError('Reasoning is too long', { reasoning: 'max 1000 characters' });
    }

    const now = nowIso();
    let vote: PersonEvaluation;
    if (session.agent) {
      vote = this.#agentVote(voter, existing, input, now);
    } else {
      vote = PersonEvaluationSchema.parse({
        personSlug: slug,
        evaluator: humanEvaluatorFor(voter.slug),
        verdict: input.verdict,
        confidence: 1,
        flags: ['manual-override'],
        ...(input.reasoning && input.reasoning.trim() !== '' ? { reasoning: input.reasoning.trim() } : {}),
        evaluatedAt: now,
      });
    }

    const previousWasSpam = latestVoteWasSpam(this.#state, existing);
    await tx.public['person-evaluations'].upsert(vote);
    const stateApply = new StateApply().upsertPersonEvaluation(vote);

    let person = existing;
    if (input.verdict === 'spam' && !existing.deletedAt) {
      person = PersonSchema.parse({ ...existing, deletedAt: now, updatedAt: now });
    } else if (input.verdict === 'legit' && existing.deletedAt && previousWasSpam) {
      person = PersonSchema.parse({ ...existing, deletedAt: null, updatedAt: now });
    }
    if (person !== existing) {
      await tx.public.people.upsert(person);
      stateApply.upsertPerson(person);
    }

    return { person, vote, stateApply };
  }

  /** The agent vote rules (moderation.md → Agent votes, 1–4) and the record. */
  #agentVote(agent: Person, target: Person, input: CastVoteInput, now: string): PersonEvaluation {
    const reasoning = input.reasoning?.trim() ?? '';
    if (reasoning.length < 1 || reasoning.length > 1000) {
      throw new ApiValidationError('An agent must say why (1–1000 characters)', { reasoning: 'required, 1–1000 characters' });
    }
    const flags = validateFlags(input.flags);

    // 1. Humans are final.
    if (hasHumanVote(this.#state, target)) {
      throw new ConflictError('A person has already voted on this member', 'human_verdict_exists');
    }
    // 2. Only ordinary members.
    if (target.accountLevel !== 'user') {
      throw new ConflictError('Only ordinary members can be voted on by an agent', 'protected_account');
    }
    if (input.verdict === 'spam') {
      // 3. Only new members, for spam.
      if (Date.parse(now) - Date.parse(target.createdAt) > AGENT_SPAM_VOTE_MAX_AGE_DAYS * DAY_MS) {
        throw new ConflictError(
          `A spam vote needs a member who joined in the last ${AGENT_SPAM_VOTE_MAX_AGE_DAYS} days`,
          'member_too_old',
        );
      }
      // 4. Volume: 20 spam votes in any rolling 24 hours, from its own records.
      const recent = this.#agentSpamVoteTimes(agent.slug, Date.parse(now));
      if (recent.length >= AGENT_SPAM_VOTES_PER_DAY) {
        const frees = recent[recent.length - AGENT_SPAM_VOTES_PER_DAY]! + DAY_MS;
        throw new RateLimitedError(Math.max(1, Math.ceil((frees - Date.parse(now)) / 1000)));
      }
    }

    return PersonEvaluationSchema.parse({
      personSlug: target.slug,
      evaluator: agentEvaluatorFor(agent.slug),
      verdict: input.verdict,
      flags: ['agent', ...flags.filter((f) => f !== 'agent')],
      reasoning,
      evaluatedAt: now,
    });
  }

  /** `evaluatedAt` (ms) of the agent's spam votes in the last 24 hours, oldest first. */
  #agentSpamVoteTimes(agentSlug: string, now: number): number[] {
    const evaluator = agentEvaluatorFor(agentSlug);
    const times: number[] = [];
    for (const rec of this.#state.personEvaluations.values()) {
      if (rec.evaluator !== evaluator || rec.verdict !== 'spam' || rec.flags.includes('purged')) continue;
      const at = Date.parse(rec.evaluatedAt);
      if (now - at < DAY_MS) times.push(at);
    }
    return times.sort((a, b) => a - b);
  }

  /**
   * `DELETE /api/admin/members/:slug/vote` — the calling agent takes back
   * its own vote. Refused once a human has voted (the agent's vote is then
   * history). If it was the latest vote, it was `spam`, and no other agent's
   * `spam` vote remains, the member is reactivated.
   */
  async withdrawVote(
    tx: DualStoreTx,
    slug: string,
    session: SessionContext,
  ): Promise<{ person: Person; stateApply: StateApply }> {
    const agent = this.#agentOf(session);
    const existing = this.#personOr404(slug);
    const evaluator = agentEvaluatorFor(agent.slug);
    const mine = agentVotesOnAccount(this.#state, existing).find((v) => v.evaluator === evaluator);
    if (!mine) throw new ApiNotFoundError(`No vote by ${agent.slug} on '${slug}'`);
    if (hasHumanVote(this.#state, existing)) {
      throw new ConflictError('A person has voted on this member; the agent vote is the record', 'human_verdict_exists');
    }
    return this.#removeAgentVotes(tx, existing, [mine], new StateApply());
  }

  /**
   * Delete `votes` (agent votes on `person`'s account) and apply the reversal
   * rule: reactivate when the latest vote was one of them and `spam`, and no
   * other agent's `spam` vote remains.
   */
  async #removeAgentVotes(
    tx: DualStoreTx,
    existing: Person,
    votes: readonly PersonEvaluation[],
    stateApply: StateApply,
  ): Promise<{ person: Person; stateApply: StateApply; reactivated: boolean }> {
    const all = votesOnAccount(this.#state, existing).filter((v) => evaluatorKind(v.evaluator) !== 'machine');
    const latest = newestVote(all);
    const removing = new Set(votes.map((v) => v.evaluator));
    for (const v of votes) {
      await tx.public['person-evaluations'].delete(v);
      stateApply.removePersonEvaluation(v);
    }
    const otherSpam = all.some(
      (v) => !removing.has(v.evaluator) && evaluatorKind(v.evaluator) === 'agent' && v.verdict === 'spam',
    );
    let person = existing;
    if (
      existing.deletedAt &&
      latest !== null &&
      removing.has(latest.evaluator) &&
      latest.verdict === 'spam' &&
      !otherSpam
    ) {
      const now = nowIso();
      person = PersonSchema.parse({ ...existing, deletedAt: null, updatedAt: now });
      await tx.public.people.upsert(person);
      stateApply.upsertPerson(person);
    }
    return { person, stateApply, reactivated: person !== existing };
  }

  /**
   * `POST /api/admin/agents/:slug/withdraw-votes` — delete every vote agent
   * `agentSlug` cast (newer than `since`) on a person with no human vote,
   * reactivating each person its vote hid. Votes on people a human has since
   * voted on, and on people who no longer exist (or on an earlier account
   * under a slug), are left as the record. One commit.
   */
  async withdrawAll(
    tx: DualStoreTx,
    agentSlug: string,
    since: string | null,
    stateApply: StateApply = new StateApply(),
  ): Promise<{ withdrawn: number; reactivated: number; stateApply: StateApply }> {
    const evaluator = agentEvaluatorFor(agentSlug);
    let withdrawn = 0;
    let reactivated = 0;
    for (const person of [...this.#state.people.values()]) {
      const mine = agentVotesOnAccount(this.#state, person).find((v) => v.evaluator === evaluator);
      if (!mine) continue;
      if (since && Date.parse(mine.evaluatedAt) < Date.parse(since)) continue;
      if (hasHumanVote(this.#state, person)) continue;
      const result = await this.#removeAgentVotes(tx, person, [mine], stateApply);
      withdrawn++;
      if (result.reactivated) reactivated++;
    }
    return { withdrawn, reactivated, stateApply };
  }
}
