/**
 * Person + PrivateProfile mutations triggered by the GitHub OAuth callback.
 *
 * Two entry points:
 *   - createFreshFromGitHub: brand-new user — generate slug, Person, PrivateProfile
 *   - refreshLinkedFromGitHub: existing-linked user — refresh githubLogin + email
 *
 * Both run inside `store.transact` so the public commit and private write are
 * atomic per the dual-store contract.
 */
import {
  PersonSchema,
  PrivateProfileSchema,
  type Person,
  type PrivateProfile,
} from '@cfp/shared/schemas';
import { uuidv7 } from 'uuidv7';
import type { DualStoreTx } from '../store/store.js';
import type { InMemoryState } from '../store/memory/state.js';
import { StateApply } from '../store/state-apply.js';
import {
  ensureUniqueSlug,
  isReservedSlug,
  isValidPersonSlug,
  slugify,
} from '../lib/slug.js';
import type { ResolvedGitHubIdentity } from '../auth/github-client.js';

const PERSON_SLUG_MAX = 50;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Slugify a GitHub login into something that satisfies the Person slug regex.
 *
 * GitHub logins permit only `[a-zA-Z0-9]` and single internal hyphens; our
 * Person slug regex is roughly the lowercase equivalent. Most logins map
 * directly. Fallbacks for edge cases:
 *  - lowercase first
 *  - if it starts with `-`, prepend `user-`
 *  - if reserved, prepend `user-`
 *  - if still invalid (shouldn't happen for any real GH login), fall back to `user-<gh-id>`
 */
export function slugifyGitHubLogin(login: string, ghId: number): string {
  const base = slugify(login, PERSON_SLUG_MAX);
  if (isValidPersonSlug(base) && !isReservedSlug(base)) return base;
  const prefixed = slugify(`user-${login}`, PERSON_SLUG_MAX);
  if (isValidPersonSlug(prefixed) && !isReservedSlug(prefixed)) return prefixed;
  return `user-${ghId}`;
}

export interface CreateFreshResult {
  readonly person: Person;
  readonly profile: PrivateProfile;
  readonly stateApply: StateApply;
}

export class GitHubAccountService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  /**
   * Create a fresh Person + PrivateProfile from a GitHub identity. Caller must
   * have already validated that no candidates exist (so this won't shadow a
   * legacy account).
   *
   * Email is optional in the OAuth payload but we still create the Person if
   * absent; the matching algorithm only routes here when there are no
   * candidates, which already required at least the OAuth handshake to succeed.
   * If `primaryEmail` is null at this point, the route handler should have
   * already redirected to `email_unverified`.
   */
  async createFresh(
    tx: DualStoreTx,
    identity: ResolvedGitHubIdentity,
    primaryEmail: string,
  ): Promise<CreateFreshResult> {
    const now = nowIso();
    const id = uuidv7();
    const baseSlug = slugifyGitHubLogin(identity.login, identity.id);
    const slug = ensureUniqueSlug(
      baseSlug,
      (candidate) => this.#state.personIdBySlug.has(candidate) || isReservedSlug(candidate),
      PERSON_SLUG_MAX,
    );

    const person: Person = PersonSchema.parse({
      id,
      slug,
      fullName: identity.name && identity.name.length > 0 ? identity.name : identity.login,
      accountLevel: 'user',
      githubUserId: identity.id,
      githubLogin: identity.login,
      githubLinkedAt: now,
      slackSamlNameId: slug,
      createdAt: now,
      updatedAt: now,
    });

    const profile: PrivateProfile = PrivateProfileSchema.parse({
      personId: id,
      email: primaryEmail.toLowerCase(),
      emailRefreshedAt: now,
      newsletter: null,
      updatedAt: now,
    });

    await tx.public.people.upsert(person);
    tx.private.putProfile(profile);

    const stateApply = new StateApply().upsertPerson(person);
    return { person, profile, stateApply };
  }

  /**
   * Refresh an existing-linked Person + PrivateProfile from a GitHub identity.
   *
   * - Person.githubLogin is updated if GitHub changed the login
   * - PrivateProfile.email is replaced with the current GitHub primary email
   *   (the user "changes email" by changing it on GitHub, per the spec)
   *
   * Returns a StateApply that is empty unless the Person record actually
   * changed (no-op refresh of the same login is silent).
   */
  async refreshLinked(
    tx: DualStoreTx,
    existing: Person,
    identity: ResolvedGitHubIdentity,
    primaryEmail: string | null,
    currentProfile: PrivateProfile | null,
  ): Promise<{ person: Person; stateApply: StateApply; publicChanged: boolean }> {
    const now = nowIso();
    const stateApply = new StateApply();

    const loginChanged = existing.githubLogin !== identity.login;
    const linkedAtMissing = !existing.githubLinkedAt;
    const publicChanged = loginChanged || linkedAtMissing;

    let updated = existing;
    if (publicChanged) {
      updated = PersonSchema.parse({
        ...existing,
        githubLogin: identity.login,
        githubLinkedAt: existing.githubLinkedAt ?? now,
        updatedAt: now,
      });
      await tx.public.people.upsert(updated);
      stateApply.upsertPerson(updated);
    }

    // Refresh email if it actually changed (avoids a no-op private flush).
    if (primaryEmail) {
      const normalized = primaryEmail.toLowerCase();
      if (!currentProfile || currentProfile.email.toLowerCase() !== normalized || !currentProfile.emailRefreshedAt) {
        const profile: PrivateProfile = PrivateProfileSchema.parse({
          personId: existing.id,
          email: normalized,
          emailRefreshedAt: now,
          newsletter: currentProfile?.newsletter ?? null,
          updatedAt: now,
        });
        tx.private.putProfile(profile);
      } else {
        // Email unchanged but we still bump emailRefreshedAt because the spec
        // says we refresh on every successful OAuth callback.
        const profile: PrivateProfile = PrivateProfileSchema.parse({
          ...currentProfile,
          emailRefreshedAt: now,
          updatedAt: now,
        });
        tx.private.putProfile(profile);
      }
    }

    return { person: updated, stateApply, publicChanged };
  }

  /**
   * Bind a GitHub identity to a Person that currently has none. Used by
   * `POST /api/auth/link-github`'s callback branch. Per
   * specs/behaviors/account-migration.md the link records the GitHub
   * fields but does NOT refresh `PrivateProfile.email` in v1 — that
   * requires a consent toggle on a link-confirmation screen that
   * doesn't yet exist. The user's existing email-on-file stays.
   *
   * Caller is responsible for the conflict checks (the Person isn't
   * already linked, and the GitHub identity isn't bound to a *different*
   * Person); this method assumes both invariants hold.
   */
  async linkToExisting(
    tx: DualStoreTx,
    existing: Person,
    identity: ResolvedGitHubIdentity,
  ): Promise<{ person: Person; stateApply: StateApply }> {
    const now = nowIso();
    const updated: Person = PersonSchema.parse({
      ...existing,
      githubUserId: identity.id,
      githubLogin: identity.login,
      githubLinkedAt: now,
      updatedAt: now,
    });
    await tx.public.people.upsert(updated);
    return { person: updated, stateApply: new StateApply().upsertPerson(updated) };
  }
}
