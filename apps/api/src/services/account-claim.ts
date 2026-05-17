/**
 * Account-claim service.
 *
 * The legacy-account claim flow per specs/api/account-claim.md and
 * specs/behaviors/account-migration.md. Three identity proofs map to three
 * write paths:
 *
 *   A. Email-match  → confirm(personId)          — auto-claim
 *   B. Password     → byPassword(slug, password) — auto-claim after verify
 *   C. Staff review → requestStaffReview(...)    — queued for admin
 *
 * Plus the post-onboarding merge path, which always goes through staff.
 *
 * All write paths run inside `store.transact` so the public commit and
 * private mutation land together; the dual-store atomicity guarantees from
 * specs/behaviors/private-storage.md apply.
 */
import {
  PersonSchema,
  PrivateProfileSchema,
  SlugHistorySchema,
  type AccountClaimRequest,
  type HelpWantedInterestExpression,
  type HelpWantedRole,
  type Person,
  type PrivateProfile,
  type ProjectBuzz,
  type ProjectMembership,
  type ProjectUpdate,
  type SlugHistory,
} from '@cfp/shared/schemas';
import { uuidv7 } from 'uuidv7';
import type { DualStoreTx } from '../store/store.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import type { PrivateStore } from '../store/private/index.js';
import type {
  ClaimPendingClaims,
  GhIdentitySnapshot,
} from '../auth/jwt.js';
import { verifyLaddrPassword, UnknownHashFormatError } from '../auth/legacy-password.js';
import { GitHubAccountService } from './github-account.js';
import type { ResolvedGitHubIdentity } from '../auth/github-client.js';

const SLUG_HISTORY_TTL_DAYS = 90;

function nowIso(): string {
  return new Date().toISOString();
}

function expiresInDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export interface CandidateSummary {
  readonly personId: string;
  readonly slug: string;
  readonly fullName: string;
  readonly memberOfCount: number;
  readonly lastActiveAt: string;
  readonly matchedVia: ReadonlyArray<'email' | 'username'>;
  readonly matchedEmail: string | null;
}

export interface CandidatesPayload {
  readonly ghLogin: string;
  readonly ghName: string | null;
  readonly candidates: CandidateSummary[];
}

export interface ClaimSuccessResult {
  readonly person: Person;
  readonly stateApply: StateApply;
}

/** Result of `confirm` and `byPassword` — used by the route to issue session. */
export type AutoClaimResult = ClaimSuccessResult;

/** Result of `decline` — fresh Person + PrivateProfile created. */
export type DeclineResult = ClaimSuccessResult;

export interface StaffApproveResult {
  readonly request: AccountClaimRequest;
  readonly person: Person | null;
  readonly stateApply: StateApply;
  /** Set only when the approval is a post-onboarding merge. */
  readonly mergeApply?: MergeApply;
}

export interface StaffDenyResult {
  readonly request: AccountClaimRequest;
}

/** Reconstruct a ResolvedGitHubIdentity from the claim-pending JWT claims. */
export function ghIdentityFromClaim(claims: ClaimPendingClaims): ResolvedGitHubIdentity {
  const id = Number(claims.sub);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Invalid GitHub id in claim JWT');
  }
  // The claim-pending JWT only carries email *strings*, not the full
  // {primary,verified} tuples we get from /user/emails. By construction every
  // email in the JWT was verified at OAuth time, so we reconstruct flags.
  const emails = claims.ghEmails.map((email, idx) => ({
    email,
    primary: idx === 0,
    verified: true,
  }));
  return {
    id,
    login: claims.ghLogin,
    name: claims.ghName,
    emails,
    primaryEmail: emails[0]?.email ?? null,
  };
}

/** Reconstruct a GhIdentitySnapshot from the claim-pending JWT claims. */
export function ghSnapshotFromClaim(claims: ClaimPendingClaims): GhIdentitySnapshot {
  return {
    ghId: claims.sub,
    ghLogin: claims.ghLogin,
    ghName: claims.ghName,
    ghEmails: claims.ghEmails,
  };
}

export class AccountClaimService {
  readonly #state: InMemoryState;
  readonly #privateStore: PrivateStore;
  readonly #githubAccount: GitHubAccountService;

  constructor(
    state: InMemoryState,
    privateStore: PrivateStore,
    githubAccount: GitHubAccountService,
  ) {
    this.#state = state;
    this.#privateStore = privateStore;
    this.#githubAccount = githubAccount;
  }

  /**
   * Build candidate summaries for the candidate IDs carried in a claim JWT.
   * Skips any IDs that no longer resolve (deleted) or that have since been
   * claimed by another GitHub identity (race).
   */
  async buildCandidateSummaries(claims: ClaimPendingClaims): Promise<CandidatesPayload> {
    const verifiedEmails = new Set(claims.ghEmails.map((e) => e.toLowerCase()));
    const usernameSlug = claims.ghLogin.toLowerCase();
    const candidates: CandidateSummary[] = [];

    for (const personId of claims.candidates) {
      const person = this.#state.people.get(personId);
      if (!person || person.deletedAt || person.githubUserId) continue;

      const profile = await this.#privateStore.getProfile(personId);
      const matchedEmail =
        profile && verifiedEmails.has(profile.email.toLowerCase()) ? profile.email : null;
      const usernameMatch = person.slug.toLowerCase() === usernameSlug;
      const matchedVia: Array<'email' | 'username'> = [];
      if (matchedEmail) matchedVia.push('email');
      if (usernameMatch) matchedVia.push('username');
      if (matchedVia.length === 0) continue;

      candidates.push({
        personId: person.id,
        slug: person.slug,
        fullName: person.fullName,
        memberOfCount: this.#state.membershipsByPerson.get(person.id)?.size ?? 0,
        lastActiveAt: person.updatedAt,
        matchedVia,
        matchedEmail,
      });
    }

    return {
      ghLogin: claims.ghLogin,
      ghName: claims.ghName,
      candidates,
    };
  }

  /**
   * Confirm an email-match candidate. The candidate must be in the JWT's
   * candidate set AND have a verified GitHub email matching its PrivateProfile.
   * Username-only matches throw `email_match_required` — those must use
   * by-password or staff-review.
   */
  async confirm(
    tx: DualStoreTx,
    claims: ClaimPendingClaims,
    personId: string,
  ): Promise<
    | { ok: true; result: AutoClaimResult }
    | { ok: false; code: 'not_a_candidate' | 'email_match_required' | 'already_claimed' }
  > {
    if (!claims.candidates.includes(personId)) {
      return { ok: false, code: 'not_a_candidate' };
    }
    const person = this.#state.people.get(personId);
    if (!person || person.deletedAt) {
      return { ok: false, code: 'not_a_candidate' };
    }
    if (person.githubUserId) {
      return { ok: false, code: 'already_claimed' };
    }

    const profile = await this.#privateStore.getProfile(personId);
    const verifiedEmails = new Set(claims.ghEmails.map((e) => e.toLowerCase()));
    if (!profile || !verifiedEmails.has(profile.email.toLowerCase())) {
      return { ok: false, code: 'email_match_required' };
    }

    const identity = ghIdentityFromClaim(claims);
    const primaryEmail = identity.primaryEmail ?? identity.emails[0]?.email ?? null;
    if (!primaryEmail) {
      // Should not happen — OAuth callback would have rejected this — but
      // guard anyway so we never silently drop an email refresh.
      return { ok: false, code: 'email_match_required' };
    }

    const claimed = await this.#linkLegacyPerson(tx, person, identity, primaryEmail, profile);
    return { ok: true, result: claimed };
  }

  /**
   * Decline all candidates: create a brand-new Person + PrivateProfile per the
   * github-oauth "create-fresh" path. Legacy candidates remain available for
   * someone else to claim.
   */
  async decline(tx: DualStoreTx, claims: ClaimPendingClaims): Promise<DeclineResult> {
    const identity = ghIdentityFromClaim(claims);
    const primaryEmail = identity.primaryEmail ?? identity.emails[0]?.email;
    if (!primaryEmail) {
      throw new Error('Cannot decline without a verified GitHub email');
    }
    const created = await this.#githubAccount.createFresh(tx, identity, primaryEmail);
    return { person: created.person, stateApply: created.stateApply };
  }

  /**
   * Verify legacy username + password and, on match, claim the candidate.
   *
   * Returns a uniform `invalid` for "no such slug," "already-claimed,"
   * "no credential on file," "wrong password," or unknown hash format
   * (the last case is logged separately via the caller, since we still
   * want a uniform user-visible response).
   */
  async byPassword(
    tx: DualStoreTx,
    claims: ClaimPendingClaims,
    slug: string,
    password: string,
  ): Promise<
    | { ok: true; result: AutoClaimResult }
    | { ok: false; code: 'invalid'; reason: 'no_slug' | 'already_claimed' | 'no_credential' | 'wrong_password' | 'unknown_format' }
  > {
    const personId = this.#state.personIdBySlug.get(slug.toLowerCase());
    if (!personId) {
      return { ok: false, code: 'invalid', reason: 'no_slug' };
    }
    const person = this.#state.people.get(personId);
    if (!person || person.deletedAt) {
      return { ok: false, code: 'invalid', reason: 'no_slug' };
    }
    if (person.githubUserId) {
      return { ok: false, code: 'invalid', reason: 'already_claimed' };
    }

    const cred = await this.#privateStore.getLegacyPassword(person.id);
    if (!cred) {
      return { ok: false, code: 'invalid', reason: 'no_credential' };
    }

    let matched: boolean;
    try {
      matched = await verifyLaddrPassword(password, cred.passwordHash);
    } catch (err) {
      if (err instanceof UnknownHashFormatError) {
        return { ok: false, code: 'invalid', reason: 'unknown_format' };
      }
      throw err;
    }
    if (!matched) {
      return { ok: false, code: 'invalid', reason: 'wrong_password' };
    }

    const identity = ghIdentityFromClaim(claims);
    const primaryEmail = identity.primaryEmail ?? identity.emails[0]?.email ?? null;
    if (!primaryEmail) {
      // Same guard as confirm()
      return { ok: false, code: 'invalid', reason: 'wrong_password' };
    }

    const profile = await this.#privateStore.getProfile(person.id);
    const claimed = await this.#linkLegacyPerson(tx, person, identity, primaryEmail, profile);
    return { ok: true, result: claimed };
  }

  /**
   * Create an open AccountClaimRequest. Always succeeds (anti-enumeration):
   * the response is identical whether or not the claimed slug exists.
   */
  async requestStaffReview(
    tx: DualStoreTx,
    claims: ClaimPendingClaims,
    claimedSlug: string,
    evidence: string,
  ): Promise<{ request: AccountClaimRequest }> {
    const personId = this.#state.personIdBySlug.get(claimedSlug.toLowerCase()) ?? null;
    const request: AccountClaimRequest = {
      id: uuidv7(),
      type: 'pre-onboarding',
      claimedPersonId: personId,
      claimedSlug,
      requesterGithubLogin: claims.ghLogin,
      requesterGithubId: Number(claims.sub),
      requesterPersonId: null,
      evidence,
      status: 'open',
      submittedAt: nowIso(),
      reviewedAt: null,
      reviewedBy: null,
      reviewedReason: null,
    };
    tx.private.putClaimRequest(request);
    return { request };
  }

  /**
   * Post-onboarding search: signed-in user looks for their own legacy account.
   * Anti-enumeration: returns 0 or 1 candidate; nothing reveals which slugs
   * exist beyond what the user themselves typed.
   */
  async legacySearch(q: string, requesterPersonId: string): Promise<CandidateSummary | null> {
    const trimmed = q.trim().toLowerCase();
    if (!trimmed) return null;

    let personId: string | null;
    let matchedVia: Array<'email' | 'username'> = [];
    let matchedEmail: string | null = null;

    if (trimmed.includes('@')) {
      personId = await this.#privateStore.findPersonIdByEmail(trimmed);
      if (personId) {
        matchedVia = ['email'];
        const p = await this.#privateStore.getProfile(personId);
        matchedEmail = p?.email ?? null;
      }
    } else {
      personId = this.#state.personIdBySlug.get(trimmed) ?? null;
      if (personId) matchedVia = ['username'];
    }
    if (!personId) return null;
    if (personId === requesterPersonId) return null;

    const person = this.#state.people.get(personId);
    if (!person || person.deletedAt || person.githubUserId) return null;

    return {
      personId: person.id,
      slug: person.slug,
      fullName: person.fullName,
      memberOfCount: this.#state.membershipsByPerson.get(person.id)?.size ?? 0,
      lastActiveAt: person.updatedAt,
      matchedVia,
      matchedEmail,
    };
  }

  /**
   * Post-onboarding staff-review submission. The requester is a signed-in user
   * who realized later they had a legacy account. Approval triggers the merge.
   */
  async legacyRequest(
    tx: DualStoreTx,
    requester: Person,
    requesterGithubId: number,
    claimedSlug: string,
    evidence: string,
  ): Promise<{ request: AccountClaimRequest }> {
    const personId = this.#state.personIdBySlug.get(claimedSlug.toLowerCase()) ?? null;
    const request: AccountClaimRequest = {
      id: uuidv7(),
      type: 'post-onboarding-merge',
      claimedPersonId: personId,
      claimedSlug,
      requesterGithubLogin: requester.githubLogin ?? '',
      requesterGithubId,
      requesterPersonId: requester.id,
      evidence,
      status: 'open',
      submittedAt: nowIso(),
      reviewedAt: null,
      reviewedBy: null,
      reviewedReason: null,
    };
    tx.private.putClaimRequest(request);
    return { request };
  }

  /** Staff queue listing. Open requests only. */
  async staffQueue(): Promise<AccountClaimRequest[]> {
    const all = await this.#privateStore.listOpenClaimRequests();
    return all.slice().sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  }

  /** Mark a request denied. */
  async staffDeny(
    tx: DualStoreTx,
    requestId: string,
    staffPersonId: string,
    reason: string | null,
  ): Promise<
    | { ok: true; result: StaffDenyResult }
    | { ok: false; code: 'not_found' | 'already_reviewed' }
  > {
    const existing = await this.#privateStore.getClaimRequest(requestId);
    if (!existing) return { ok: false, code: 'not_found' };
    if (existing.status !== 'open') return { ok: false, code: 'already_reviewed' };

    const updated: AccountClaimRequest = {
      ...existing,
      status: 'denied',
      reviewedAt: nowIso(),
      reviewedBy: staffPersonId,
      reviewedReason: reason,
    };
    tx.private.putClaimRequest(updated);
    return { ok: true, result: { request: updated } };
  }

  /** Approve a request — pre-onboarding link or post-onboarding merge. */
  async staffApprove(
    tx: DualStoreTx,
    requestId: string,
    staffPersonId: string,
    reason: string | null,
  ): Promise<
    | { ok: true; result: StaffApproveResult }
    | { ok: false; code: 'not_found' | 'already_reviewed' | 'no_claimed_person' | 'requester_missing' | 'already_claimed' }
  > {
    const existing = await this.#privateStore.getClaimRequest(requestId);
    if (!existing) return { ok: false, code: 'not_found' };
    if (existing.status !== 'open') return { ok: false, code: 'already_reviewed' };
    if (!existing.claimedPersonId) return { ok: false, code: 'no_claimed_person' };

    const claimed = this.#state.people.get(existing.claimedPersonId);
    if (!claimed || claimed.deletedAt) return { ok: false, code: 'no_claimed_person' };

    const stateApply = new StateApply();
    const now = nowIso();

    if (existing.type === 'pre-onboarding') {
      // Link the requester's GitHub identity to the claimed legacy Person.
      // The requester has no Person yet (pre-onboarding), so on their next
      // sign-in the GitHub callback's byGithubUserId lookup will hit.
      if (claimed.githubUserId) {
        return { ok: false, code: 'already_claimed' };
      }
      const updated = PersonSchema.parse({
        ...claimed,
        githubUserId: existing.requesterGithubId,
        githubLogin: existing.requesterGithubLogin,
        githubLinkedAt: now,
        updatedAt: now,
      });
      await tx.public.people.upsert(updated);
      stateApply.upsertPerson(updated);

      const markedReviewed: AccountClaimRequest = {
        ...existing,
        status: 'approved',
        reviewedAt: now,
        reviewedBy: staffPersonId,
        reviewedReason: reason,
      };
      tx.private.putClaimRequest(markedReviewed);
      return { ok: true, result: { request: markedReviewed, person: updated, stateApply } };
    }

    // post-onboarding-merge
    if (!existing.requesterPersonId) return { ok: false, code: 'requester_missing' };
    const requester = this.#state.people.get(existing.requesterPersonId);
    if (!requester || requester.deletedAt) return { ok: false, code: 'requester_missing' };
    if (claimed.githubUserId) return { ok: false, code: 'already_claimed' };

    const mergeApply = await this.#mergePostOnboarding(tx, claimed, requester, now);
    // Replay all merge ops onto our StateApply via its public API.
    mergeApply.replay(stateApply);

    const markedReviewed: AccountClaimRequest = {
      ...existing,
      status: 'approved',
      reviewedAt: now,
      reviewedBy: staffPersonId,
      reviewedReason: reason,
    };
    tx.private.putClaimRequest(markedReviewed);
    return {
      ok: true,
      result: {
        request: markedReviewed,
        person: mergeApply.updatedPerson,
        stateApply,
        mergeApply,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Link a GitHub identity to a legacy Person:
   *   - Person: set githubUserId/Login/LinkedAt, fix slackSamlNameId if absent
   *   - PrivateProfile: refresh email + emailRefreshedAt
   *   - LegacyPasswordCredential: delete (no longer needed)
   */
  async #linkLegacyPerson(
    tx: DualStoreTx,
    person: Person,
    identity: ResolvedGitHubIdentity,
    primaryEmail: string,
    currentProfile: PrivateProfile | null,
  ): Promise<AutoClaimResult> {
    const now = nowIso();
    const updated = PersonSchema.parse({
      ...person,
      githubUserId: identity.id,
      githubLogin: identity.login,
      githubLinkedAt: now,
      // Legacy import seeds slackSamlNameId from slug. If a legacy Person
      // somehow lacks it, set it to the current slug so SAML continuity holds.
      slackSamlNameId: person.slackSamlNameId ?? person.slug,
      updatedAt: now,
    });
    await tx.public.people.upsert(updated);

    const profile: PrivateProfile = PrivateProfileSchema.parse({
      personId: person.id,
      email: primaryEmail.toLowerCase(),
      emailRefreshedAt: now,
      newsletter: currentProfile?.newsletter ?? null,
      updatedAt: now,
    });
    tx.private.putProfile(profile);
    tx.private.deleteLegacyPassword(person.id);

    const stateApply = new StateApply().upsertPerson(updated);
    return { person: updated, stateApply };
  }

  /**
   * Merge a fresh requester Person into a legacy claimed Person. The legacy
   * Person wins (per account-migration.md): all records authored by the
   * requester are re-pointed to the legacy Person id, the requester Person is
   * hard-deleted, the legacy Person gains the GitHub link, and a slug-history
   * entry redirects the requester's slug for 90 days.
   *
   * Returns a structured payload the caller composes onto its StateApply.
   */
  async #mergePostOnboarding(
    tx: DualStoreTx,
    claimed: Person,
    requester: Person,
    now: string,
  ): Promise<MergeApply> {
    // Re-point authored records --------------------------------------------

    const reMemberships: ProjectMembership[] = [];
    const removedMemberships: ProjectMembership[] = [];
    const requesterMembershipIds = this.#state.membershipsByPerson.get(requester.id) ?? new Set();
    for (const mId of requesterMembershipIds) {
      const m = this.#state.projectMemberships.get(mId);
      if (!m) continue;
      const mPath = m as ProjectMembership & { projectSlug: string; personSlug: string };
      // If the claimed Person already has a membership in this project,
      // drop the requester's duplicate rather than creating two.
      const claimedMemberships = this.#state.membershipsByPerson.get(claimed.id) ?? new Set();
      const claimedHasIt = [...claimedMemberships].some((id) => {
        const cm = this.#state.projectMemberships.get(id);
        return cm?.projectId === m.projectId;
      });
      if (claimedHasIt) {
        await tx.public['project-memberships'].delete(mPath as unknown as ProjectMembership);
        removedMemberships.push(m);
        continue;
      }
      const updated: ProjectMembership = {
        ...m,
        personId: claimed.id,
        personSlug: claimed.slug,
      } as ProjectMembership;
      // Path template uses {projectSlug}/{personSlug}, so renaming personSlug
      // moves the file: delete the old key, then upsert the new one.
      await tx.public['project-memberships'].delete(mPath as unknown as ProjectMembership);
      await tx.public['project-memberships'].upsert(updated);
      reMemberships.push(updated);
    }

    const reUpdates: ProjectUpdate[] = [];
    for (const u of this.#state.projectUpdates.values()) {
      if (u.authorId !== requester.id) continue;
      const updated: ProjectUpdate = { ...u, authorId: claimed.id };
      await tx.public['project-updates'].upsert(updated);
      reUpdates.push(updated);
    }

    const reBuzz: ProjectBuzz[] = [];
    for (const b of this.#state.projectBuzz.values()) {
      if (b.postedById !== requester.id) continue;
      const updated: ProjectBuzz = { ...b, postedById: claimed.id };
      await tx.public['project-buzz'].upsert(updated);
      reBuzz.push(updated);
    }

    const reRoles: HelpWantedRole[] = [];
    for (const r of this.#state.helpWantedRoles.values()) {
      let updated: HelpWantedRole | null = null;
      if (r.postedById === requester.id) {
        updated = { ...(updated ?? r), postedById: claimed.id };
      }
      if (r.filledById === requester.id) {
        updated = { ...(updated ?? r), filledById: claimed.id };
      }
      if (updated) {
        await tx.public['help-wanted-roles'].upsert(updated);
        reRoles.push(updated);
      }
    }

    const reInterest: HelpWantedInterestExpression[] = [];
    const removedInterest: HelpWantedInterestExpression[] = [];
    for (const e of this.#state.helpWantedInterest.values()) {
      if (e.personId !== requester.id) continue;
      const ePath = e as HelpWantedInterestExpression & { personSlug: string };
      // Dedupe: if the claimed Person already expressed interest in this role,
      // drop the requester's row.
      const claimedKey = `${e.roleId}:${claimed.id}`;
      const claimedExisting = this.#state.interestByRoleAndPerson.get(claimedKey);
      if (claimedExisting) {
        await tx.public['help-wanted-interest'].delete(ePath as unknown as HelpWantedInterestExpression);
        removedInterest.push(e);
        continue;
      }
      const updated: HelpWantedInterestExpression = {
        ...e,
        personId: claimed.id,
        personSlug: claimed.slug,
      } as HelpWantedInterestExpression;
      await tx.public['help-wanted-interest'].delete(ePath as unknown as HelpWantedInterestExpression);
      await tx.public['help-wanted-interest'].upsert(updated);
      reInterest.push(updated);
    }

    // Update the claimed Person with GitHub identity ----------------------

    const updatedClaimed = PersonSchema.parse({
      ...claimed,
      githubUserId: requester.githubUserId ?? claimed.githubUserId ?? null,
      githubLogin: requester.githubLogin ?? claimed.githubLogin ?? null,
      githubLinkedAt: now,
      slackSamlNameId: claimed.slackSamlNameId ?? claimed.slug,
      updatedAt: now,
    });
    await tx.public.people.upsert(updatedClaimed);

    // Slug history for requester's old slug -------------------------------

    const slugHistory: SlugHistory = SlugHistorySchema.parse({
      id: uuidv7(),
      entityType: 'person',
      oldSlug: requester.slug,
      newSlug: claimed.slug,
      entityId: claimed.id,
      changedAt: now,
      expiresAt: expiresInDays(SLUG_HISTORY_TTL_DAYS),
    });
    await tx.public['slug-history'].upsert(slugHistory);

    // Hard-delete the requester Person -----------------------------------

    await tx.public.people.delete(requester);

    // Private side: refresh claimed profile email if requester had a fresher
    // one, then delete requester's profile.
    const claimedProfile = await this.#privateStore.getProfile(claimed.id);
    const requesterProfile = await this.#privateStore.getProfile(requester.id);
    if (requesterProfile) {
      const merged: PrivateProfile = PrivateProfileSchema.parse({
        personId: claimed.id,
        email: requesterProfile.email,
        emailRefreshedAt: now,
        newsletter: claimedProfile?.newsletter ?? requesterProfile.newsletter ?? null,
        updatedAt: now,
      });
      tx.private.putProfile(merged);
      tx.private.deleteProfile(requester.id);
    }
    // No legacy password remains for the claimed Person at this point
    // (post-onboarding flow means the legacy Person was unclaimed); delete
    // anything still present defensively.
    tx.private.deleteLegacyPassword(claimed.id);

    return new MergeApply({
      updatedPerson: updatedClaimed,
      deletedRequesterPersonId: requester.id,
      deletedRequesterSlug: requester.slug,
      reMemberships,
      removedMemberships,
      reUpdates,
      reBuzz,
      reRoles,
      reInterest,
      removedInterest,
    });
  }
}

// ---------------------------------------------------------------------------
// MergeApply — sequenced in-memory updates queued for the post-onboarding merge
// ---------------------------------------------------------------------------

interface MergeApplyInput {
  readonly updatedPerson: Person;
  readonly deletedRequesterPersonId: string;
  readonly deletedRequesterSlug: string;
  readonly reMemberships: ProjectMembership[];
  readonly removedMemberships: ProjectMembership[];
  readonly reUpdates: ProjectUpdate[];
  readonly reBuzz: ProjectBuzz[];
  readonly reRoles: HelpWantedRole[];
  readonly reInterest: HelpWantedInterestExpression[];
  readonly removedInterest: HelpWantedInterestExpression[];
}

export class MergeApply {
  readonly updatedPerson: Person;
  readonly deletedRequesterPersonId: string;
  readonly ops: ReadonlyArray<unknown> = [];
  readonly #input: MergeApplyInput;

  constructor(input: MergeApplyInput) {
    this.#input = input;
    this.updatedPerson = input.updatedPerson;
    this.deletedRequesterPersonId = input.deletedRequesterPersonId;
  }

  /**
   * Replay all merge mutations onto a StateApply via its public API. After
   * `stateApply.apply()`, callers must also invoke `hardRemovePersonFromState`
   * to clear the requester Person — StateApply doesn't expose a hard-remove
   * for Person, and the merge specifically wants the requester id to disappear.
   */
  replay(stateApply: StateApply): void {
    const i = this.#input;
    stateApply.upsertPerson(i.updatedPerson);
    for (const m of i.reMemberships) stateApply.upsertMembership(m);
    for (const m of i.removedMemberships) stateApply.removeMembership(m);
    for (const u of i.reUpdates) stateApply.upsertProjectUpdate(u);
    for (const b of i.reBuzz) stateApply.upsertProjectBuzz(b);
    for (const r of i.reRoles) stateApply.upsertHelpWantedRole(r);
    for (const e of i.reInterest) stateApply.upsertInterest(e);
  }

  hardRemovePersonFromState(state: InMemoryState, fts: { removePerson: (slug: string) => void }): void {
    const i = this.#input;
    const oldId = i.deletedRequesterPersonId;
    const oldSlug = i.deletedRequesterSlug;
    state.people.delete(oldId);
    state.personSlugById.delete(oldId);
    state.personIdBySlug.delete(oldSlug);
    state.membershipsByPerson.delete(oldId);
    fts.removePerson(oldSlug);
    // Clean up removed interest rows that were de-duped during merge.
    for (const e of i.removedInterest) {
      state.helpWantedInterest.delete(e.id);
      state.interestByRole.get(e.roleId)?.delete(e.id);
      const key = `${e.roleId}:${e.personId}`;
      if (state.interestByRoleAndPerson.get(key) === e.id) {
        state.interestByRoleAndPerson.delete(key);
      }
    }
  }
}

