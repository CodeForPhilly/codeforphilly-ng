import type {
  AccountClaimRequest,
  LegacyPasswordCredential,
  PasswordToken,
  PrivateProfile,
} from '@cfp/shared/schemas';

/** Secondary in-memory indices built from private store data. */
export interface PrivateIndices {
  /** email (lowercase) → personId */
  readonly byEmail: Map<string, string>;
  /** unsubscribeToken → personId */
  readonly byUnsubscribeToken: Map<string, string>;
  /** personId → LegacyPasswordCredential */
  readonly legacyPasswordByPersonId: Map<string, LegacyPasswordCredential>;
}

/**
 * Transaction object passed to PrivateStore.transact handlers.
 * Mutations are applied to in-memory state; the `.jsonl` files are
 * flushed after the handler completes.
 */
export interface PrivateStoreTx {
  putProfile(profile: PrivateProfile): void;
  deleteProfile(personId: string): void;
  putLegacyPassword(cred: LegacyPasswordCredential): void;
  deleteLegacyPassword(personId: string): void;
  putClaimRequest(req: AccountClaimRequest): void;
}

/**
 * The private data store interface.
 *
 * Two implementations: FilesystemPrivateStore (dev) and S3PrivateStore (prod).
 * Both follow the load-at-boot + in-memory + PUT-on-mutation pattern from
 * specs/behaviors/private-storage.md.
 */
export interface PrivateStore {
  /** Load both .jsonl files into memory. Must be called before any reads. */
  load(): Promise<void>;

  /** Secondary in-memory indices, populated after load(). */
  readonly indices: PrivateIndices;

  // --- Profiles ---
  getProfile(personId: string): Promise<PrivateProfile | null>;
  putProfile(profile: PrivateProfile): Promise<void>;
  deleteProfile(personId: string): Promise<void>;
  findPersonIdByEmail(email: string): Promise<string | null>;
  listAllProfiles(): AsyncIterable<PrivateProfile>;

  // --- Legacy passwords ---
  getLegacyPassword(personId: string): Promise<LegacyPasswordCredential | null>;
  putLegacyPassword(cred: LegacyPasswordCredential): Promise<void>;
  deleteLegacyPassword(personId: string): Promise<void>;
  countLegacyPasswords(): Promise<number>;

  // --- Password-reset tokens ---
  getPasswordToken(tokenHash: string): Promise<PasswordToken | null>;
  putPasswordToken(token: PasswordToken): Promise<void>;
  deletePasswordToken(tokenHash: string): Promise<void>;

  // --- Account-claim requests ---
  getClaimRequest(requestId: string): Promise<AccountClaimRequest | null>;
  putClaimRequest(req: AccountClaimRequest): Promise<void>;
  listOpenClaimRequests(): Promise<AccountClaimRequest[]>;
  listAllClaimRequests(): Promise<AccountClaimRequest[]>;

  /**
   * Run a handler with a transaction object. On success, flush updated
   * `.jsonl` files to the backend. On throw, discard; in-memory state
   * is not updated.
   */
  transact<T>(handler: (tx: PrivateStoreTx) => Promise<T>): Promise<T>;

  /**
   * Read an arbitrary blob from the private store by key.
   * Returns null if the blob does not exist.
   * For session metadata and other non-record private data.
   */
  readBlob(key: string): Promise<string | null>;

  /**
   * Write an arbitrary blob to the private store by key.
   * For session metadata and other non-record private data.
   */
  writeBlob(key: string, content: string): Promise<void>;
}
