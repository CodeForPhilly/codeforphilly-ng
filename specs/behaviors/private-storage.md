# Behavior: Private Storage

## Rule

Private data — anything that would be a privacy or security problem if exposed publicly — lives in an **S3-compatible bucket**, separate from the public gitsheets data repo. The public repo carries nothing sensitive; bucket access is gated behind production credentials no contributor ever holds.

## Applies To

- [data-model.md](../data-model.md) — every entity that has a public/private split (currently `Person`, `LegacyPasswordCredential`)
- [behaviors/storage.md](storage.md) — sibling system to the public gitsheets store
- [behaviors/account-migration.md](account-migration.md) — legacy account claim reads private profiles
- [api/auth.md](../api/auth.md) — GitHub OAuth callback writes private profile
- [api/account-claim.md](../api/account-claim.md) — claim endpoints read/write private records

## Why a separate store

The public gitsheets repo is **public by design** — civic-transparency win, free contributor onboarding via the scrubbed snapshot. That posture only works if the repo genuinely has no PII or secrets. Field-level encryption was considered and rejected (see [deferred.md](../deferred.md) and [GitHub gitsheets#143](https://github.com/JarvusInnovations/gitsheets/issues/143)) because:

- Public ciphertext is forever-harvestable; key compromise at any time exposes everything historical
- Encrypted-PII-in-public is a legal gray zone vs. "PII simply isn't in public"
- Adds substantial library complexity to gitsheets

A second private *gitsheets* repo was also considered and rejected:

- We don't need record semantics, querying, or versioning for private data
- Devs would inevitably end up with private clones on their laptops
- Cross-repo atomicity is similar to bucket-store atomicity — both are eventually-consistent

Bucket storage matches the access pattern (point lookups + one bulk read), keeps real PII off dev laptops by construction, and adds minimal operational surface.

## On-disk layout

Two `.jsonl` files in the bucket. Each holds the latest state of every record of one entity type, one record per line.

```text
bucket/
├── profiles.jsonl              # private profile per Person — email, newsletter prefs, etc.
└── legacy-passwords.jsonl      # imported from laddr; drains to zero post-migration
```

That's the entire on-disk footprint. No per-record files, no indexes on disk, no append-only log series.

### Record shapes

**`profiles.jsonl`** — one line per Person:

```json
{
  "personId": "01951a3c-...",
  "email": "jane@example.com",
  "emailRefreshedAt": "2026-05-15T18:42:00Z",
  "newsletter": {
    "optedIn": true,
    "optedInAt": "2026-04-01T...",
    "unsubscribeToken": "base64url-32byte"
  },
  "updatedAt": "2026-05-15T18:42:00Z"
}
```

**`legacy-passwords.jsonl`** — one line per migrated Person who hasn't yet claimed via password-match:

```json
{
  "personId": "01951a3c-...",
  "passwordHash": "<laddr-era hash as-is>",
  "importedAt": "2026-05-01T..."
}
```

The records are deleted from the file when the user claims via any path (email match, password match, or staff approval). The file shrinks monotonically until it's empty.

## Runtime model

Mirrors the public gitsheets model:

1. **Boot:** GET each `.jsonl` from the bucket. Parse line-by-line into `Map<personId, Record>`. Build secondary in-memory indexes (`Map<emailLowercase, personId>` for claim-flow lookup).
2. **Reads:** in-memory only, sub-microsecond. Never re-fetch from the bucket between boots.
3. **Mutations:** Update in-memory state under the existing write mutex. Then PUT the updated `.jsonl` file back to the bucket synchronously (within the same request).
4. **Failures:** Bucket PUT failures bubble up as `PrivateStoreError` (codes `private_store_unavailable`, `private_store_conflict`). The in-memory state is updated only after the PUT succeeds.

PUT semantics: bucket PUTs are atomic per-object. There's no half-written-file hazard.

## Atomicity with the public commit

A consumer-facing mutation that touches both public (gitsheets) and private (bucket) state runs:

1. Inside `repo.transact`, stage public gitsheets writes
2. Build the new private state in memory (don't PUT yet)
3. On handler success:
   - **Step A** — commit the public gitsheets tree (advances public state, pushes via push daemon)
   - **Step B** — PUT updated private `.jsonl` file(s) (advances private state)

The dual-write is **not atomic across the two stores**. Mitigations:

- **Write order is use-case-specific:**
  - **Account creation:** write private **first**. If private fails, no public-visible artifact yet. If private succeeds and public fails, we have an orphan private profile referencing a `personId` that doesn't exist in the public repo — easy to detect and clean up.
  - **Updates / deletes:** public first. Rollback of a public commit (revert) is straightforward if private fails.
- **Reconciliation script** — `apps/api/scripts/reconcile.ts` walks the public Person records and ensures each has a matching `profiles.jsonl` entry; flags orphans on both sides, plus inconsistent newsletter state and drained legacy-password credentials.
- **Loud failure** — partial commits log structured errors at `level >= 40` so they flow to the `#alerts` Slack channel via the log webhook (see [docs/operations/monitoring.md](../../docs/operations/monitoring.md)). Admins intervene for the handful per year that hit this.

In practice the dual-write moment is **rare** — primarily account creation. Most mutations touch only one side: updating a project (public only) or refreshing email at login (private only).

## Boot ordering

The API loads:

1. The public gitsheets data into memory ([behaviors/storage.md](storage.md))
2. The private store into memory (this spec)
3. The in-memory FTS index from the public state ([behaviors/storage.md#full-text-search](storage.md#full-text-search))
4. Starts serving HTTP

If the private store is unreachable at boot, the API logs an error and refuses to serve — the API depends on private profiles for login. Reachability is a hard prerequisite.

## Backends

The `PrivateStore` interface is backend-agnostic. Two backends ship in v1:

### `s3` backend (production)

Targets any S3-compatible object store:

- Configured via `STORAGE_BACKEND=s3` plus `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`
- Uses `@aws-sdk/client-s3` (works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, Hetzner Object Storage, etc.)
- The exact provider is a deploy choice, not a spec one. MinIO inside the existing cluster is the cheapest path; R2 is cheaper for egress; any of them works.

### `filesystem` backend (development + ephemeral use)

Targets a local directory:

- Configured via `STORAGE_BACKEND=filesystem` plus `CFP_PRIVATE_STORAGE_PATH=./private-storage/`
- Reads and writes `.jsonl` files in the configured directory using `node:fs/promises`
- Writes are atomic via the temp-file-then-rename pattern
- **Devs never touch the production bucket.** They get this backend and either an empty `private-storage/` (sign up fresh during dev) or a fixture-seeded one shipped in the code repo at `fixtures/private-storage-seeded/`

The two backends are interchangeable as far as the API code is concerned. Switching is one env var.

## Bucket versioning

Production buckets **must** have versioning enabled. Every PUT preserves the previous version of the object. Recovery from a bad write — application bug, accidental deletion, etc. — is `aws s3api copy-object --copy-source bucket/profiles.jsonl?versionId=...`. Cheap insurance.

The filesystem backend doesn't replicate versioning. Dev mode is lossy by design; production isn't.

## What's NOT in the bucket

- **Authentication credentials** (passwords, hashed or otherwise) for the *active* system. v1 has no password auth — only GitHub OAuth — so this is trivially true. The `legacy-passwords.jsonl` is the one exception, drains to zero, and is treated as one-shot migration data.
- **Auth tokens.** JWT signing keys live in the deploy environment, not the bucket. Revocation state is in-memory only (see [behaviors/authorization.md](authorization.md)).
- **Public records.** Anything that the public site displays — project READMEs, member profiles, tags, help-wanted listings — stays in the public gitsheets repo.

## Audit

The bucket has *some* audit visibility via bucket versioning (per-object history), but it's not the rich commit-message-with-trailers audit log the public repo provides. We accept this:

- Most mutations that matter for audit (project edits, member changes, stage transitions, help-wanted state) are in the public repo and audited there
- Private mutations are narrow (email refresh, newsletter opt-in) and rarely require forensic introspection
- If we ever need richer audit, bucket versioning + the object's `LastModified` is enough to answer "what was the previous version?"

## API surface (for consumers inside our code, not exposed via HTTP)

```typescript
interface PrivateStore {
  // Profiles
  getProfile(personId: string): Promise<PrivateProfile | null>;
  putProfile(profile: PrivateProfile): Promise<void>;
  deleteProfile(personId: string): Promise<void>;
  findPersonIdByEmail(email: string): Promise<string | null>;
  listAllProfiles(): AsyncIterable<PrivateProfile>;  // for newsletter export

  // Legacy passwords
  getLegacyPassword(personId: string): Promise<LegacyPasswordCredential | null>;
  deleteLegacyPassword(personId: string): Promise<void>;
  countLegacyPasswords(): Promise<number>;           // for migration-progress visibility
}
```

Implementation lives at `apps/api/src/store/private/`. Single class with two backend implementations behind one interface.

## Deferred / out of scope

- **Bulk encryption at rest beyond bucket-native** (e.g., SSE-KMS). Provider-managed if the bucket supports it; not a library-level concern.
- **Per-field crypto inside the bucket records.** If a future use case wants it — e.g., a "shared secret" between admin and user — that's an additive feature; the jsonl can carry encrypted fields without changing the rest of the design.
- **Cross-region replication.** Bucket-provider-level feature; configure on the bucket if disaster-recovery requires it.
- **Read replicas / sharding.** Not at v1 scale.

## Coordinates with

- [behaviors/storage.md](storage.md) — public gitsheets store; the request-bound commit lifecycle that the dual-write hooks into is at [storage.md#request-bound-commit-lifecycle](storage.md#request-bound-commit-lifecycle)
- [behaviors/account-migration.md](account-migration.md) — the largest private-store-reading flow
- [api/auth.md](../api/auth.md) — GitHub OAuth callback updates the profile
- [architecture.md](../architecture.md) — bucket as a stack dependency

Upstream transaction semantics (`repo.transact`, commit-on-success-only, single-writer mutex) are owned by gitsheets — see the gitsheets repo's `specs/behaviors/transactions.md`.
