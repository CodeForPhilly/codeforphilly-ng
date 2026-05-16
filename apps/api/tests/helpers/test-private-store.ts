import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Minimal PrivateProfile shape from specs/behaviors/private-storage.md.
 * The authoritative Zod schema lives in packages/shared once storage-foundation
 * lands; this is the structural subset the test helper needs to compile.
 */
export interface PrivateProfile {
  readonly personId: string;
  readonly email: string;
  readonly emailRefreshedAt: string;
  readonly newsletter: {
    readonly optedIn: boolean;
    readonly optedInAt: string | null;
    readonly unsubscribeToken: string | null;
  };
  readonly updatedAt: string;
}

/**
 * Subset of the PrivateStore interface (specs/behaviors/private-storage.md).
 * Implements only the methods exercised by test helpers today; the full
 * interface lands with storage-foundation.
 */
export interface TestPrivateStore {
  putProfile(profile: PrivateProfile): Promise<void>;
  getProfile(personId: string): Promise<PrivateProfile | null>;
  findPersonIdByEmail(email: string): Promise<string | null>;
}

export interface AppTestPrivateStore {
  readonly store: TestPrivateStore;
  /** Absolute path to the temp directory backing this store. */
  readonly path: string;
  /** Remove the temp directory. Idempotent. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Create a filesystem-backed PrivateStore fixture in a temp directory.
 *
 * Writes are atomic via temp-file-then-rename, matching the production
 * filesystem backend contract in specs/behaviors/private-storage.md.
 *
 * This shim implements the test-facing surface only. The production
 * filesystem and S3 backends land with the storage-foundation plan.
 */
export async function createTestPrivateStore(): Promise<AppTestPrivateStore> {
  const dir = await mkdtemp(join(tmpdir(), 'cfp-private-store-'));
  await mkdir(dir, { recursive: true });

  const profilesPath = join(dir, 'profiles.jsonl');

  const readProfiles = async (): Promise<Map<string, PrivateProfile>> => {
    const map = new Map<string, PrivateProfile>();
    let raw: string;
    try {
      raw = await readFile(profilesPath, 'utf8');
    } catch {
      return map;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const record = JSON.parse(trimmed) as PrivateProfile;
      map.set(record.personId, record);
    }
    return map;
  };

  const writeProfiles = async (profiles: Map<string, PrivateProfile>): Promise<void> => {
    const lines = [...profiles.values()].map((p) => JSON.stringify(p)).join('\n');
    const tmp = `${profilesPath}.tmp`;
    await writeFile(tmp, lines ? lines + '\n' : '', 'utf8');
    await rename(tmp, profilesPath);
  };

  const store: TestPrivateStore = {
    async putProfile(profile) {
      const profiles = await readProfiles();
      profiles.set(profile.personId, profile);
      await writeProfiles(profiles);
    },

    async getProfile(personId) {
      const profiles = await readProfiles();
      return profiles.get(personId) ?? null;
    },

    async findPersonIdByEmail(email) {
      const profiles = await readProfiles();
      for (const profile of profiles.values()) {
        if (profile.email.toLowerCase() === email.toLowerCase()) {
          return profile.personId;
        }
      }
      return null;
    },
  };

  let cleaned = false;
  return {
    store,
    path: dir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
