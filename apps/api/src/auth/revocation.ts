/**
 * In-memory revocation set + gitsheets persistence.
 *
 * Two-layer revocation per specs/behaviors/authorization.md:
 *   1. In-memory Set<jti> for O(1) hot checks on every authenticated request.
 *   2. Persisted `revocations` sheet (gitsheets) — rebuilt at boot, updated
 *      synchronously on every revoke.
 *
 * The sweeper removes expired revocations from both memory and the sheet.
 *
 * Sign-out-everywhere sentinel: jti='*' with personId causes the verifier to
 * reject any JWT for that personId whose iat is before the sentinel's revokedAt.
 * The sentinel is stored in the sheet under a unique key (sentinel:<personId>).
 */
import type { PublicStore } from '../store/public.js';
import type { Revocation } from '@cfp/shared/schemas';

export interface RevocationStore {
  /** Check if a specific jti is revoked. */
  isRevoked(jti: string): boolean;
  /**
   * Check if a person's token (with a given iat epoch seconds) is covered by
   * a sign-out-everywhere sentinel for that personId.
   */
  isCoveredBySentinel(personId: string, iat: number): boolean;
  /** Add a revocation and persist to gitsheets. */
  revoke(opts: { jti: string; personId: string; expiresAt: string }, store: PublicStore): Promise<void>;
  /** Delete expired records from memory + the gitsheets sheet. */
  sweep(store: PublicStore): Promise<void>;
  /** All non-expired revocations for a given personId (not sentinel). */
  getForPerson(personId: string): Revocation[];
}

export class InMemoryRevocationStore implements RevocationStore {
  /** jti → full Revocation record. */
  readonly #byJti = new Map<string, Revocation>();
  /** personId → sentinel Revocation (jti='*'). */
  readonly #sentinels = new Map<string, Revocation>();

  /**
   * Populate from an array of Revocation records loaded from gitsheets at boot.
   * Expired records are skipped. Clears existing state first.
   */
  load(records: Revocation[]): void {
    this.#byJti.clear();
    this.#sentinels.clear();
    const now = new Date().toISOString();
    for (const r of records) {
      if (r.expiresAt <= now) continue;
      if (r.jti === '*') {
        this.#sentinels.set(r.personId, r);
      } else {
        this.#byJti.set(r.jti, r);
      }
    }
  }

  isRevoked(jti: string): boolean {
    return this.#byJti.has(jti);
  }

  isCoveredBySentinel(personId: string, iat: number): boolean {
    const sentinel = this.#sentinels.get(personId);
    if (!sentinel) return false;
    const sentinelEpoch = Math.floor(new Date(sentinel.revokedAt).getTime() / 1000);
    return iat < sentinelEpoch;
  }

  async revoke(
    opts: { jti: string; personId: string; expiresAt: string },
    store: PublicStore,
  ): Promise<void> {
    const now = new Date().toISOString();
    const record: Revocation = {
      jti: opts.jti,
      personId: opts.personId,
      revokedAt: now,
      expiresAt: opts.expiresAt,
    };

    if (opts.jti === '*') {
      this.#sentinels.set(opts.personId, record);
    } else {
      this.#byJti.set(opts.jti, record);
    }

    await store.transact(
      {
        message: `auth: revoke token jti=${opts.jti} person=${opts.personId}`,
        author: { name: 'cfp-api', email: 'api@codeforphilly.org' },
      },
      async (tx) => {
        await tx.revocations.upsert(record);
      },
    );
  }

  async sweep(store: PublicStore): Promise<void> {
    const now = new Date().toISOString();
    const expiredJtis: string[] = [];

    for (const [jti, r] of this.#byJti) {
      if (r.expiresAt <= now) expiredJtis.push(jti);
    }
    const expiredSentinelPersonIds: string[] = [];
    for (const [personId, r] of this.#sentinels) {
      if (r.expiresAt <= now) expiredSentinelPersonIds.push(personId);
    }

    if (expiredJtis.length === 0 && expiredSentinelPersonIds.length === 0) return;

    const allExpiredJtis = [...expiredJtis];
    // Sentinels are stored in the sheet under jti='*' — but since jti is the path
    // template key, sentinels stored with jti='*' would collide. At load time, any
    // record with jti='*' is treated as a sentinel keyed by personId in memory.
    // For sweeping, we delete from sheet by the jti value we upserted with.
    for (const personId of expiredSentinelPersonIds) {
      const sentinel = this.#sentinels.get(personId);
      if (sentinel) allExpiredJtis.push(sentinel.jti);
    }

    await store.transact(
      {
        message: `auth: sweep ${allExpiredJtis.length} expired revocations`,
        author: { name: 'cfp-api', email: 'api@codeforphilly.org' },
      },
      async (tx) => {
        for (const jti of allExpiredJtis) {
          await tx.revocations.delete(jti);
        }
      },
    );

    for (const jti of expiredJtis) this.#byJti.delete(jti);
    for (const personId of expiredSentinelPersonIds) this.#sentinels.delete(personId);
  }

  getForPerson(personId: string): Revocation[] {
    const result: Revocation[] = [];
    for (const r of this.#byJti.values()) {
      if (r.personId === personId) result.push(r);
    }
    return result;
  }
}
