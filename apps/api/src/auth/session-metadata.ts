/**
 * Session metadata store — UA + IP + timestamps per refresh-token jti.
 *
 * Stored as a single JSON blob in the private bucket so it survives restarts
 * but is never in the public commit log (no PII in git per
 * specs/behaviors/storage.md#pii-aware-redaction).
 *
 * In-memory map keyed by refreshJti; flushed to private store on each mutation.
 */
import type { PrivateStore } from '../store/private/index.js';

export interface SessionMeta {
  readonly refreshJti: string;
  readonly personId: string;
  readonly userAgent: string;
  readonly ipAddress: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const STORAGE_KEY = 'session-metadata.json';

export class SessionMetadataStore {
  readonly #map = new Map<string, SessionMeta>();

  async load(privateStore: PrivateStore): Promise<void> {
    const raw = await privateStore.readBlob(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, SessionMeta>;
      for (const [jti, meta] of Object.entries(parsed)) {
        this.#map.set(jti, meta);
      }
    } catch {
      // Corrupt metadata is non-fatal — start fresh
    }
  }

  private async flush(privateStore: PrivateStore): Promise<void> {
    const obj: Record<string, SessionMeta> = {};
    for (const [jti, meta] of this.#map) {
      obj[jti] = meta;
    }
    await privateStore.writeBlob(STORAGE_KEY, JSON.stringify(obj));
  }

  async add(meta: SessionMeta, privateStore: PrivateStore): Promise<void> {
    this.#map.set(meta.refreshJti, meta);
    await this.flush(privateStore);
  }

  async remove(refreshJti: string, privateStore: PrivateStore): Promise<void> {
    this.#map.delete(refreshJti);
    await this.flush(privateStore);
  }

  getAll(personId: string): SessionMeta[] {
    const result: SessionMeta[] = [];
    for (const meta of this.#map.values()) {
      if (meta.personId === personId) result.push(meta);
    }
    return result;
  }

  get(refreshJti: string): SessionMeta | null {
    return this.#map.get(refreshJti) ?? null;
  }

  has(refreshJti: string): boolean {
    return this.#map.has(refreshJti);
  }
}
