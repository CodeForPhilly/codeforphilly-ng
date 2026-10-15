---
status: done
depends: [scheduled-spam-purge]
specs:
  - specs/behaviors/person-lifecycle.md
  - specs/api/moderation.md
issues: []
pr: 255
---

# Plan: Gate the scheduled purge to production; purge private data too

## Scope

v0.10.2 shipped the scheduled spam purge early (2026-10-15). The sandbox ran
the sweep against `published`, which it shares with production, and purged
27 spam-voted accounts there. The accounts were the right ones, but two
flaws showed: every pod runs the sweep, and purge never touched the private
store, so purged people's private profiles stayed behind.

**In:** `CFP_SCHEDULED_PURGE` (default off; on only in cfp-live-cluster), and
a pod with it off never sweeps and says so at boot; Purge (button and sweep)
deletes private profile, legacy password, reset tokens, claim requests and
session metadata in the same transaction; `POST
/api/admin/private-data/purge-orphans` (admin, `apply` false/true, counts
only) for private data left by earlier purges and prunes.

**Out:** an out-of-process script for the cleanup (the API's in-memory
private store would write the old data back).

## Implements

- [behaviors/person-lifecycle.md](../specs/behaviors/person-lifecycle.md#purge-cascading-hard-delete-admin-only)
- [api/moderation.md](../specs/api/moderation.md#post-apiadminprivate-datapurge-orphans)
- docs/operations/deploy.md (env table), runbook.md.

## Approach

1. `PrivateStoreTx.deletePersonData(personId)`, staged by `store.transact`
   like the other private writes; `purgePeople` calls it per person.
2. `SessionMetadataStore.removeAllFor(personId)` after the commit.
3. `scheduledPurgeEnabled(config)` gates the plugin.
4. The orphan cleanup runs under `publicRepo.withLock`, so a sign-up that
   has written its private profile but not its public record is never
   counted.

## Validation

- [x] `npm run type-check && npm run lint && npm test` clean.
- [x] Tests: the gate; `deletePersonData` persisted to disk, other people
  untouched; Purge deletes the private profile; the cleanup is
  admin-only, counts without emails, deletes on `apply`, then counts 0.

## Risks / unknowns

- `apply: true` can't be undone; the runbook says to count first.

## Notes

- Incident: #253 merged 35 s before Release #254 was cut, so v0.10.2
  carried it; the sandbox's boot sweep wrote 5e11d592e ("people:
  scheduled spam purge (27)") to the shared `published`. Production was
  held on v0.10.1 and goes straight to v0.10.3.
- Devbox (flag unset): the pod logged "scheduled spam purge disabled" and
  wrote no data commit.
- Chose an in-API admin endpoint over the operator script first proposed:
  the API rewrites whole private-store files from memory on its next
  private write, so a script beside a live pod would be undone.

## Follow-ups

- **None.** Operator steps (set the flag in cfp-live-cluster, run the
  cleanup with Chris's OK) are in the runbook and with the release.
