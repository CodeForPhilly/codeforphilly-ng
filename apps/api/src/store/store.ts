import type { TransactionOptions, TransactionResult } from 'gitsheets';
import type { PrivateProfile } from '@cfp/shared/schemas';
import type { PrivateStore, PrivateStoreTx } from './private/index.js';
import type { PublicStore, PublicStoreTx } from './public.js';

/** The combined context passed to store.transact handlers. */
export interface DualStoreTx {
  /** Access to the typed gitsheets sheets within the public transaction. */
  readonly public: PublicStoreTx;
  /** Access to private store mutations staged within this transaction. */
  readonly private: PrivateStoreTx;
}

/**
 * Write-order policy for cross-store transactions.
 *
 * - 'private-first': Write private state before the public commit.
 *   Use for account creation: if private fails, no public artifact exists.
 * - 'public-first': Commit public gitsheets tree before the private PUT.
 *   Use for updates/deletes: public is the primary, private is the complement.
 */
export type WriteOrder = 'private-first' | 'public-first';

export interface StoreTransactOptions extends TransactionOptions {
  /**
   * Whether this transaction touches only public state, only private state,
   * or both. Controls dual-write sequencing.
   *
   * Default: 'public-first'.
   */
  readonly writeOrder?: WriteOrder;
}

/**
 * Dual-store coordinator wrapping a gitsheets PublicStore and a PrivateStore.
 *
 * store.transact runs the handler with access to both sides and sequences the
 * final writes per the writeOrder policy per specs/behaviors/private-storage.md.
 */
export class Store {
  readonly #public: PublicStore;
  readonly #private: PrivateStore;

  constructor(publicStore: PublicStore, privateStore: PrivateStore) {
    this.#public = publicStore;
    this.#private = privateStore;
  }

  get public(): PublicStore {
    return this.#public;
  }

  get private(): PrivateStore {
    return this.#private;
  }

  /**
   * Execute a handler inside a cross-store transaction.
   *
   * The handler receives both a gitsheets transaction (tx.public) and a
   * private-store mutation object (tx.private). On handler success, writes
   * are sequenced per `writeOrder`. On throw, nothing is committed.
   *
   * Cross-store rollback uses the reconciliation approach documented in
   * specs/behaviors/private-storage.md: if the private flush fails after
   * the public commit, the error is thrown loud and a reconciliation script
   * should be run to align state. There is no automatic git-revert of the
   * public commit.
   */
  async transact<T>(
    opts: StoreTransactOptions,
    handler: (tx: DualStoreTx) => Promise<T>,
  ): Promise<TransactionResult<T>> {
    const writeOrder = opts.writeOrder ?? 'public-first';

    // Staged private mutations collected during the handler
    const stagedPrivatePuts: PrivateProfile[] = [];
    const stagedPrivateProfileDeletes: string[] = [];
    const stagedLegacyPasswordDeletes: string[] = [];

    const privateTx: PrivateStoreTx = {
      putProfile: (profile) => { stagedPrivatePuts.push(profile); },
      deleteProfile: (personId) => { stagedPrivateProfileDeletes.push(personId); },
      deleteLegacyPassword: (personId) => { stagedLegacyPasswordDeletes.push(personId); },
    };

    const hasPrivateMutations = () =>
      stagedPrivatePuts.length > 0 ||
      stagedPrivateProfileDeletes.length > 0 ||
      stagedLegacyPasswordDeletes.length > 0;

    const flushPrivate = async (): Promise<void> => {
      if (!hasPrivateMutations()) return;
      await this.#private.transact(async (tx) => {
        for (const profile of stagedPrivatePuts) tx.putProfile(profile);
        for (const id of stagedPrivateProfileDeletes) tx.deleteProfile(id);
        for (const id of stagedLegacyPasswordDeletes) tx.deleteLegacyPassword(id);
      });
    };

    // Run the handler inside the public transaction, sequencing the private
    // flush per writeOrder AFTER the handler has had a chance to stage mutations.
    return this.#public.transact(opts, async (tx) => {
      const result = await handler({ public: tx, private: privateTx });
      if (writeOrder === 'private-first') {
        // Flush private inside the public.transact callback, before gitsheets
        // commits. If private flush throws, the transact callback exits with an
        // error and gitsheets won't commit the public tree — atomic-ish.
        await flushPrivate();
      }
      return result;
    }).then(async (result) => {
      if (writeOrder === 'public-first') {
        // Default: public committed first. If private flush fails after the
        // public commit, throw loudly for reconciliation.
        await flushPrivate();
      }
      return result;
    });
  }
}
