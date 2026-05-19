/**
 * Single-slot async lock for serializing data-repo operations that bypass
 * `store.transact` — namely, the boot-time reconciliation (this plan) and
 * the future hot-reload webhook (#65).
 *
 * Why not reuse gitsheets' internal `Mutex`? It serializes calls to
 * `Repository.transact` but it is per-Repository-instance and isn't exposed
 * on the public Repository surface — we'd have to reach through internals.
 * A dedicated lock at the Fastify layer is the cleanest place to coordinate
 * reconciliation against future webhook-driven transacts.
 *
 * At boot there's no contention; the lock is uncontended and overhead is
 * a microtask. Once #65 lands, the webhook handler acquires this lock
 * before fetching + rebuilding the in-memory state, and any concurrent
 * write request that calls `store.transact` will wait inside gitsheets'
 * internal mutex (which the webhook avoids holding while it does the
 * external git fetch). Reconciliation and transacts therefore stay
 * mutually exclusive as long as #65's handler acquires this lock for the
 * duration of `reconcileDataRepo` AND defers any in-memory rebuild until
 * after release.
 */

export type DataRepoLockRelease = () => void;
export type DataRepoLock = () => Promise<DataRepoLockRelease>;

/**
 * Create a fresh single-slot lock. Multiple callers calling `acquire()`
 * (the returned function) queue FIFO; only one holds the lock at a time.
 *
 * The returned release function is idempotent — calling it twice releases
 * exactly once.
 */
export function createDataRepoLock(): DataRepoLock {
  // Tail of the promise chain. Each acquire chains a new pending promise
  // onto `tail`; the previous holder's release resolves the prior tail.
  let tail: Promise<void> = Promise.resolve();

  return async function acquire(): Promise<DataRepoLockRelease> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = tail;
    tail = next;
    await prior;

    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      release();
    };
  };
}
