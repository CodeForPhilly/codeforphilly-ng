/**
 * Private data left by people who no longer exist publicly — the cleanup
 * behind `POST /api/admin/private-data/purge-orphans`
 * (specs/api/moderation.md). Purge deletes private data in the same
 * transaction now; everyone purged or pruned before that left a private
 * profile, legacy password, claim requests and session metadata behind.
 *
 * Runs inside the API on purpose: the API holds the private store in memory
 * and rewrites whole files on each private write, so an out-of-process
 * cleanup would be undone by the next write.
 */
import type { SessionMetadataStore } from '../auth/session-metadata.js';
import type { PrivateStore } from '../store/private/index.js';

export interface OrphanPrivateData {
  /** Person ids with private data and no public record. */
  readonly personIds: string[];
  readonly profiles: number;
  readonly legacyPasswords: number;
  readonly claimRequests: number;
  readonly sessions: number;
}

/** Find private data whose person is not in `publicIds`. */
export async function findOrphanPrivateData(
  publicIds: ReadonlySet<string>,
  privateStore: PrivateStore,
  sessions: SessionMetadataStore,
): Promise<OrphanPrivateData> {
  const orphans = new Set<string>();
  let profiles = 0;
  let legacyPasswords = 0;
  let claimRequests = 0;
  let sessionCount = 0;

  for await (const profile of privateStore.listAllProfiles()) {
    if (!publicIds.has(profile.personId)) {
      orphans.add(profile.personId);
      profiles++;
    }
  }
  for (const personId of privateStore.indices.legacyPasswordByPersonId.keys()) {
    if (!publicIds.has(personId)) {
      orphans.add(personId);
      legacyPasswords++;
    }
  }
  for (const req of await privateStore.listAllClaimRequests()) {
    const ids = [req.claimedPersonId, req.requesterPersonId].filter((id): id is string => !!id);
    const gone = ids.filter((id) => !publicIds.has(id));
    if (gone.length > 0) {
      gone.forEach((id) => orphans.add(id));
      claimRequests++;
    }
  }
  for (const personId of orphans) sessionCount += sessions.getAll(personId).length;

  return {
    personIds: [...orphans].sort(),
    profiles,
    legacyPasswords,
    claimRequests,
    sessions: sessionCount,
  };
}

/** Delete the private data of `found.personIds`. */
export async function purgeOrphanPrivateData(
  found: OrphanPrivateData,
  privateStore: PrivateStore,
  sessions: SessionMetadataStore,
): Promise<void> {
  await privateStore.transact(async (tx) => {
    for (const personId of found.personIds) tx.deletePersonData(personId);
  });
  for (const personId of found.personIds) await sessions.removeAllFor(personId, privateStore);
}

