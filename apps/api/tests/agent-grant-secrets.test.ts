/**
 * The private half of an agent grant — specs/behaviors/private-storage.md →
 * `agent-grant-secrets.jsonl`: only the token's SHA-256 is kept, looked up by
 * hash, and a purge of the agent account deletes its lines.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FilesystemPrivateStore } from '../src/store/private/index.js';
import { createPrivateStorageDir } from './helpers/test-full-repo.js';

const AGENT = '01951a3c-0000-7000-8000-0000000003a1';
const OTHER = '01951a3c-0000-7000-8000-0000000003a2';
const G1 = '01951a3c-0000-7000-8000-0000000003b1';
const G2 = '01951a3c-0000-7000-8000-0000000003b2';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

describe('agent grant secrets (private store)', () => {
  let dir: { path: string; cleanup: () => Promise<void> };

  beforeAll(async () => {
    dir = await createPrivateStorageDir();
  });
  afterAll(async () => {
    await dir.cleanup();
  });

  it('stores hashes in a transaction, finds them by hash, and survives a reload', async () => {
    const store = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: dir.path });
    await store.load();
    await store.transact(async (tx) => {
      tx.putGrantSecret({ grantId: G1, personId: AGENT, tokenHash: H1 });
      tx.putGrantSecret({ grantId: G2, personId: OTHER, tokenHash: H2 });
    });
    expect(store.getGrantSecretByHash(H1)?.grantId).toBe(G1);
    expect(store.getGrantSecretByHash('c'.repeat(64))).toBeNull();

    const raw = await readFile(join(dir.path, 'agent-grant-secrets.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);

    const reloaded = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: dir.path });
    await reloaded.load();
    expect(reloaded.getGrantSecretByHash(H2)?.personId).toBe(OTHER);
  });

  it('records lastUsedAt outside a transaction', async () => {
    const store = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: dir.path });
    await store.load();
    const secret = store.getGrantSecret(G1)!;
    await store.putGrantSecret({ ...secret, lastUsedAt: '2026-11-12T03:10:00Z' });
    const reloaded = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: dir.path });
    await reloaded.load();
    expect(reloaded.getGrantSecret(G1)?.lastUsedAt).toBe('2026-11-12T03:10:00Z');
  });

  it("a person purge deletes that person's grant secrets and no one else's", async () => {
    const store = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: dir.path });
    await store.load();
    await store.transact(async (tx) => {
      tx.deletePersonData(AGENT);
    });
    expect(store.getGrantSecretByHash(H1)).toBeNull();
    expect(store.getGrantSecretByHash(H2)?.grantId).toBe(G2);
    const raw = await readFile(join(dir.path, 'agent-grant-secrets.jsonl'), 'utf8');
    expect(raw).not.toContain(H1);
  });
});
