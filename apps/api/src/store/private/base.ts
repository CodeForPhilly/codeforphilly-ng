import {
  AccountClaimRequestSchema,
  LegacyPasswordCredentialSchema,
  PrivateProfileSchema,
} from '@cfp/shared/schemas';
import type {
  AccountClaimRequest,
  LegacyPasswordCredential,
  PrivateProfile,
} from '@cfp/shared/schemas';
import type { PrivateIndices, PrivateStore, PrivateStoreTx } from './interface.js';

/**
 * Shared in-memory state and logic for both PrivateStore backends.
 *
 * Subclasses implement readRaw() and writeRaw() to fetch/persist the
 * serialized .jsonl content. The rest of the interface is handled here.
 */
export abstract class BasePrivateStore implements PrivateStore {
  protected profiles: Map<string, PrivateProfile> = new Map();
  protected legacyPasswords: Map<string, LegacyPasswordCredential> = new Map();
  protected claimRequests: Map<string, AccountClaimRequest> = new Map();

  readonly indices: PrivateIndices = {
    byEmail: new Map(),
    byUnsubscribeToken: new Map(),
    legacyPasswordByPersonId: this.legacyPasswords,
  };

  /** Fetch the raw bytes of a .jsonl file by key. Return null if absent. */
  protected abstract readRaw(key: string): Promise<string | null>;
  /** Atomically write raw bytes to a .jsonl file by key. */
  protected abstract writeRaw(key: string, content: string): Promise<void>;

  async load(): Promise<void> {
    await Promise.all([
      this.loadProfiles(),
      this.loadLegacyPasswords(),
      this.loadClaimRequests(),
    ]);
    this.rebuildIndices();
  }

  private async loadProfiles(): Promise<void> {
    const raw = await this.readRaw('profiles.jsonl');
    this.profiles = parseJsonl(raw, PrivateProfileSchema);
  }

  private async loadLegacyPasswords(): Promise<void> {
    const raw = await this.readRaw('legacy-passwords.jsonl');
    const loaded = parseJsonl(raw, LegacyPasswordCredentialSchema);
    this.legacyPasswords = loaded;
    // Update the indices reference since legacyPasswords Map is replaced
    (this.indices as { legacyPasswordByPersonId: Map<string, LegacyPasswordCredential> }).legacyPasswordByPersonId =
      this.legacyPasswords;
  }

  private async loadClaimRequests(): Promise<void> {
    const raw = await this.readRaw('account-claim-requests.jsonl');
    this.claimRequests = parseJsonl(raw, AccountClaimRequestSchema, 'id');
  }

  private rebuildIndices(): void {
    this.indices.byEmail.clear();
    this.indices.byUnsubscribeToken.clear();

    for (const profile of this.profiles.values()) {
      this.indices.byEmail.set(profile.email.toLowerCase(), profile.personId);
      const token = profile.newsletter?.unsubscribeToken;
      if (token) {
        this.indices.byUnsubscribeToken.set(token, profile.personId);
      }
    }
  }

  async getProfile(personId: string): Promise<PrivateProfile | null> {
    return this.profiles.get(personId) ?? null;
  }

  async putProfile(profile: PrivateProfile): Promise<void> {
    const parsed = PrivateProfileSchema.parse(profile);
    this.profiles.set(parsed.personId, parsed);
    this.rebuildIndices();
    await this.flushProfiles();
  }

  async deleteProfile(personId: string): Promise<void> {
    this.profiles.delete(personId);
    this.rebuildIndices();
    await this.flushProfiles();
  }

  async findPersonIdByEmail(email: string): Promise<string | null> {
    return this.indices.byEmail.get(email.toLowerCase()) ?? null;
  }

  async *listAllProfiles(): AsyncIterable<PrivateProfile> {
    for (const profile of this.profiles.values()) {
      yield profile;
    }
  }

  async getLegacyPassword(personId: string): Promise<LegacyPasswordCredential | null> {
    return this.legacyPasswords.get(personId) ?? null;
  }

  async deleteLegacyPassword(personId: string): Promise<void> {
    this.legacyPasswords.delete(personId);
    await this.flushLegacyPasswords();
  }

  async countLegacyPasswords(): Promise<number> {
    return this.legacyPasswords.size;
  }

  async getClaimRequest(requestId: string): Promise<AccountClaimRequest | null> {
    return this.claimRequests.get(requestId) ?? null;
  }

  async putClaimRequest(req: AccountClaimRequest): Promise<void> {
    const parsed = AccountClaimRequestSchema.parse(req);
    this.claimRequests.set(parsed.id, parsed);
    await this.flushClaimRequests();
  }

  async listOpenClaimRequests(): Promise<AccountClaimRequest[]> {
    return [...this.claimRequests.values()].filter((r) => r.status === 'open');
  }

  async listAllClaimRequests(): Promise<AccountClaimRequest[]> {
    return [...this.claimRequests.values()];
  }

  async readBlob(key: string): Promise<string | null> {
    return this.readRaw(key);
  }

  async writeBlob(key: string, content: string): Promise<void> {
    return this.writeRaw(key, content);
  }

  async transact<T>(handler: (tx: PrivateStoreTx) => Promise<T>): Promise<T> {
    // Snapshot current state so we can roll back if the handler throws
    const profilesSnapshot = new Map(this.profiles);
    const legacySnapshot = new Map(this.legacyPasswords);
    const claimRequestsSnapshot = new Map(this.claimRequests);

    // Staged mutations applied only in-memory during the handler
    const stagedProfilePuts: Map<string, PrivateProfile> = new Map();
    const stagedProfileDeletes: Set<string> = new Set();
    const stagedLegacyDeletes: Set<string> = new Set();
    const stagedClaimRequestPuts: Map<string, AccountClaimRequest> = new Map();

    const tx: PrivateStoreTx = {
      putProfile: (profile) => {
        const parsed = PrivateProfileSchema.parse(profile);
        stagedProfilePuts.set(parsed.personId, parsed);
        stagedProfileDeletes.delete(parsed.personId);
      },
      deleteProfile: (personId) => {
        stagedProfileDeletes.add(personId);
        stagedProfilePuts.delete(personId);
      },
      deleteLegacyPassword: (personId) => {
        stagedLegacyDeletes.add(personId);
      },
      putClaimRequest: (req) => {
        const parsed = AccountClaimRequestSchema.parse(req);
        stagedClaimRequestPuts.set(parsed.id, parsed);
      },
    };

    let result: T;
    try {
      result = await handler(tx);
    } catch (err) {
      // Handler threw: leave in-memory state unchanged
      this.profiles = profilesSnapshot;
      this.legacyPasswords = legacySnapshot;
      this.claimRequests = claimRequestsSnapshot;
      this.rebuildIndices();
      throw err;
    }

    // Handler succeeded — apply staged mutations
    for (const [id, profile] of stagedProfilePuts) {
      this.profiles.set(id, profile);
    }
    for (const id of stagedProfileDeletes) {
      this.profiles.delete(id);
    }
    for (const id of stagedLegacyDeletes) {
      this.legacyPasswords.delete(id);
    }
    for (const [id, req] of stagedClaimRequestPuts) {
      this.claimRequests.set(id, req);
    }
    this.rebuildIndices();

    // Flush to backend
    const flushOps: Promise<void>[] = [];
    if (stagedProfilePuts.size > 0 || stagedProfileDeletes.size > 0) {
      flushOps.push(this.flushProfiles());
    }
    if (stagedLegacyDeletes.size > 0) {
      flushOps.push(this.flushLegacyPasswords());
    }
    if (stagedClaimRequestPuts.size > 0) {
      flushOps.push(this.flushClaimRequests());
    }

    try {
      await Promise.all(flushOps);
    } catch (err) {
      // Flush failed — in-memory is ahead of storage. Restore snapshot and
      // rebuild indices. Log loudly; a reconciliation script will fix state.
      this.profiles = profilesSnapshot;
      this.legacyPasswords = legacySnapshot;
      this.claimRequests = claimRequestsSnapshot;
      this.rebuildIndices();
      throw new PrivateStoreError(
        'private_store_unavailable',
        'Failed to flush private store after successful transaction',
        err,
      );
    }

    return result;
  }

  protected async flushProfiles(): Promise<void> {
    const lines = [...this.profiles.values()].map((p) => JSON.stringify(p)).join('\n');
    await this.writeRaw('profiles.jsonl', lines ? lines + '\n' : '');
  }

  protected async flushLegacyPasswords(): Promise<void> {
    const lines = [...this.legacyPasswords.values()].map((p) => JSON.stringify(p)).join('\n');
    await this.writeRaw('legacy-passwords.jsonl', lines ? lines + '\n' : '');
  }

  protected async flushClaimRequests(): Promise<void> {
    const lines = [...this.claimRequests.values()].map((r) => JSON.stringify(r)).join('\n');
    await this.writeRaw('account-claim-requests.jsonl', lines ? lines + '\n' : '');
  }
}

function parseJsonl<T>(
  raw: string | null,
  schema: { parse: (input: unknown) => T },
  keyField: 'personId' | 'id' = 'personId',
): Map<string, T> {
  const map = new Map<string, T>();
  if (!raw) return map;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = schema.parse(JSON.parse(trimmed));
    const keyed = record as Record<string, unknown>;
    map.set(keyed[keyField] as string, record);
  }
  return map;
}

export class PrivateStoreError extends Error {
  readonly code: string;
  override readonly cause: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'PrivateStoreError';
    this.code = code;
    this.cause = cause;
  }
}
