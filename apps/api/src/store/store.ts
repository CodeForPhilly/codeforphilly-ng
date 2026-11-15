import { AsyncLocalStorage } from 'node:async_hooks';

import type { TransactionOptions, TransactionResult } from 'gitsheets';
import type {
  AccountClaimRequest,
  AgentGrantSecret,
  LegacyPasswordCredential,
  PrivateProfile,
} from '@cfp/shared/schemas';
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
  /** Tail of the FIFO queue behind {@link exclusive}. */
  #tail: Promise<void> = Promise.resolve();
  /** Set inside {@link exclusive}, to refuse re-entry instead of deadlocking. */
  readonly #held = new AsyncLocalStorage<true>();

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
   * Run `fn` holding the store's own lock: the one every `transact` holds
   * from before its handler runs until after its `onCommit` has applied the
   * result to the in-memory state. Reads made under it see every earlier
   * write already applied (specs/api/moderation.md → Agent purges: the
   * check, the commit and the state apply under one lock). FIFO, not
   * re-entrant: a nested call throws rather than deadlocking.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#held.getStore()) {
      throw new Error('Store.exclusive / Store.transact inside the store lock would deadlock: it is not re-entrant');
    }
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.#held.run(true, fn);
    } finally {
      release();
    }
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
   *
   * `onCommit`, when given, runs after both stores are written and before
   * the store lock is released — the place to apply the handler's
   * `StateApply`, so the next transaction's handler reads it applied.
   */
  async transact<T>(
    opts: StoreTransactOptions,
    handler: (tx: DualStoreTx) => Promise<T>,
    onCommit?: (value: T) => void,
  ): Promise<TransactionResult<T>> {
    return this.exclusive(async () => {
      const result = await this.#transact(opts, handler);
      onCommit?.(result.value);
      return result;
    });
  }

  async #transact<T>(
    opts: StoreTransactOptions,
    handler: (tx: DualStoreTx) => Promise<T>,
  ): Promise<TransactionResult<T>> {
    const writeOrder = opts.writeOrder ?? 'public-first';

    // Staged private mutations collected during the handler
    const stagedPrivatePuts: PrivateProfile[] = [];
    const stagedPrivateProfileDeletes: string[] = [];
    const stagedLegacyPasswordPuts: LegacyPasswordCredential[] = [];
    const stagedLegacyPasswordDeletes: string[] = [];
    const stagedClaimRequestPuts: AccountClaimRequest[] = [];
    const stagedPersonPurges: string[] = [];
    const stagedGrantSecretPuts: AgentGrantSecret[] = [];

    const privateTx: PrivateStoreTx = {
      putProfile: (profile) => { stagedPrivatePuts.push(profile); },
      deleteProfile: (personId) => { stagedPrivateProfileDeletes.push(personId); },
      putLegacyPassword: (cred) => { stagedLegacyPasswordPuts.push(cred); },
      deleteLegacyPassword: (personId) => { stagedLegacyPasswordDeletes.push(personId); },
      putClaimRequest: (req) => { stagedClaimRequestPuts.push(req); },
      putGrantSecret: (secret) => { stagedGrantSecretPuts.push(secret); },
      deletePersonData: (personId) => { stagedPersonPurges.push(personId); },
    };

    const hasPrivateMutations = () =>
      stagedPrivatePuts.length > 0 ||
      stagedPrivateProfileDeletes.length > 0 ||
      stagedLegacyPasswordPuts.length > 0 ||
      stagedLegacyPasswordDeletes.length > 0 ||
      stagedClaimRequestPuts.length > 0 ||
      stagedGrantSecretPuts.length > 0 ||
      stagedPersonPurges.length > 0;

    const flushPrivate = async (): Promise<void> => {
      if (!hasPrivateMutations()) return;
      await this.#private.transact(async (tx) => {
        for (const profile of stagedPrivatePuts) tx.putProfile(profile);
        for (const id of stagedPrivateProfileDeletes) tx.deleteProfile(id);
        for (const cred of stagedLegacyPasswordPuts) tx.putLegacyPassword(cred);
        for (const id of stagedLegacyPasswordDeletes) tx.deleteLegacyPassword(id);
        for (const req of stagedClaimRequestPuts) tx.putClaimRequest(req);
        for (const secret of stagedGrantSecretPuts) tx.putGrantSecret(secret);
        for (const id of stagedPersonPurges) tx.deletePersonData(id);
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
