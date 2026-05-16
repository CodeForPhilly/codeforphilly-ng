---
status: done
depends: [test-harness]
specs:
  - specs/data-model.md
  - specs/behaviors/storage.md
  - specs/behaviors/private-storage.md
  - specs/behaviors/markdown-rendering.md
upstream-specs:
  # Upstream concerns owned by gitsheets — see https://github.com/JarvusInnovations/gitsheets
  # (these live in the gitsheets repo's specs/, NOT this repo's specs/)
  - gitsheets:specs/behaviors/path-templates.md
  - gitsheets:specs/behaviors/transactions.md
  - gitsheets:specs/behaviors/validation.md
  - gitsheets:specs/behaviors/normalization.md
issues: []
pr: 13
---

# Plan: Storage foundation

## Scope

The data layer: Zod schemas for every entity, the gitsheets-backed public store, the bucket-backed private store, in-memory representation, secondary indexes, and the markdown rendering pipeline. **Assumes [gitsheets v1.0](https://github.com/JarvusInnovations/gitsheets/milestone/1) has shipped** — we consume its TypeScript API directly (Repository, Sheet, Transaction, openStore).

Out of scope: HTTP surface (next plan), authorization rules (referenced but enforced in `write-api`), full-text search index (built in `read-api` once we have records to index), markdown editor in the UI (`web-shell` / `authoring-screens`).

## Implements

Own specs (this repo):

- [data-model.md](../specs/data-model.md) — every entity gets a Zod schema and Sheet declaration. The public/private split is realized via the two stores.
- [behaviors/storage.md](../specs/behaviors/storage.md) — gitsheets repo wiring, single-replica process model, in-memory state + secondary indices, sync-to-GitHub via gitsheets push daemon, the commit-message format including pseudonymous author and trailer policy.
- [behaviors/private-storage.md](../specs/behaviors/private-storage.md) — `PrivateStore` interface; S3 and filesystem backends; boot-load; PUT-on-mutation; dual-write coordination helper.
- [behaviors/markdown-rendering.md](../specs/behaviors/markdown-rendering.md) — `renderMarkdown(source): { html, excerpt }` utility in `packages/shared` (server-side rendering via unified/remark/rehype-sanitize).

Upstream specs (gitsheets) consumed by this plan — see the gitsheets repo for canonical text:

- Path templates — declared in `.gitsheets/<sheet>.toml`; gitsheets v1.0 handles rendering + query-pruning. We don't redefine the syntax.
- Transactions — public mutations flow through gitsheets's `repo.transact`; the private-side companion is `PrivateStore.transact` (own minimal mutex). Cross-store coordination is documented locally in [behaviors/private-storage.md](../specs/behaviors/private-storage.md#atomicity-with-the-public-commit).
- Validation — gitsheets calls our consumer-supplied Zod schemas (attached via `openStore({ validators })`) on top of the JSON Schema validation it does itself.
- Canonical normalization — gitsheets v1.0 handles array `sort` config + deep key sorting natively. We declare per-sheet sort rules in the sheet config when relevant.

## Approach

### Zod schemas (`packages/shared/src/schemas/`)

One file per entity. Export both the Zod schema and the inferred TypeScript type:

```typescript
export const PersonSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/),
  fullName: z.string().min(1).max(120),
  // ...
});
export type Person = z.infer<typeof PersonSchema>;
```

Schemas cover: Person, Project, ProjectMembership, ProjectUpdate, ProjectBuzz, HelpWantedRole, HelpWantedInterestExpression, Tag, TagAssignment, SlugHistory, Revocation, plus private: PrivateProfile, LegacyPasswordCredential.

### Sheet configs (`<dataRepo>/.gitsheets/<sheet>.toml`)

One per public entity. Path templates per [data-model.md](../specs/data-model.md):

```toml
# .gitsheets/people.toml
[gitsheet]
root = 'people'
path = '${{ slug }}'

[gitsheet.schema]
$ref = './schemas/Person.schema.json'

[gitsheet.fields.tags]
sort = ['namespace', 'slug']
```

Where each `.gitsheets/schemas/<Entity>.schema.json` is JSON Schema generated from the Zod schema via Zod v4's built-in `toJSONSchema` at build time. (Generated file; committed; CI verifies it's in sync with the Zod source.)

### Public store wiring (`apps/api/src/store/public.ts`)

```typescript
import { openRepo, openStore } from 'gitsheets';
import * as schemas from '@cfp/shared/schemas';

export async function openPublicStore(repoPath: string) {
  const repo = await openRepo({ gitDir: `${repoPath}/.git` });
  return openStore(repo, { validators: {
    people: schemas.PersonSchema,
    projects: schemas.ProjectSchema,
    // ...
  }});
}
```

In-memory secondary indices (`bySlug.person`, `byLegacyId.person`, `byGithubUserId`, `bySlackSamlNameId`, `membershipsByPerson`, `tagsByAssignment`, etc.) declared via `Sheet.defineIndex` per [GitHub gitsheets#134](https://github.com/JarvusInnovations/gitsheets/issues/134).

Push daemon started at boot per [GitHub gitsheets#132](https://github.com/JarvusInnovations/gitsheets/issues/132).

### Private store wiring (`apps/api/src/store/private/`)

```typescript
export interface PrivateStore {
  getProfile(personId: string): Promise<PrivateProfile | null>;
  putProfile(profile: PrivateProfile): Promise<void>;
  deleteProfile(personId: string): Promise<void>;
  findPersonIdByEmail(email: string): Promise<string | null>;
  listAllProfiles(): AsyncIterable<PrivateProfile>;
  getLegacyPassword(personId: string): Promise<LegacyPasswordCredential | null>;
  deleteLegacyPassword(personId: string): Promise<void>;
  countLegacyPasswords(): Promise<number>;
  transact<T>(handler: (tx: PrivateStoreTx) => Promise<T>): Promise<T>;
}
```

Two implementations:

- `S3PrivateStore` — backed by `@aws-sdk/client-s3` against the configured S3-compatible endpoint
- `FilesystemPrivateStore` — backed by `node:fs/promises` against `CFP_PRIVATE_STORAGE_PATH`

Both implement the same load-at-boot + in-memory + PUT-on-mutation pattern. The S3 backend enables bucket versioning at deploy; the filesystem backend uses temp-file-then-rename for atomic writes.

### Dual-store coordination (`apps/api/src/store/store.ts`)

A `Store` class wraps `openStore(repo, ...)` and a `PrivateStore` instance. `store.transact(opts, handler)` runs the handler with both `tx.public` (gitsheets transaction) and `tx.private` (private-store transaction) available. On handler success, public commits first OR private writes first per use case (see [private-storage.md](../specs/behaviors/private-storage.md#atomicity-with-the-public-commit)).

### Markdown pipeline (`packages/shared/src/markdown.ts`)

```typescript
export function renderMarkdown(source: string): { html: string, excerpt: string };
```

Wraps unified + remark + rehype-sanitize per [markdown-rendering.md](../specs/behaviors/markdown-rendering.md). Used by record-serialization to populate `*Html` and `*Excerpt` derived fields on read.

### Test helper migration (from test-harness)

The `createTestPrivateStore` shim in `apps/api/tests/helpers/test-private-store.ts` implements only the narrow surface needed by placeholder tests. Once the real `PrivateStore` interface and `FilesystemPrivateStore` implementation land in this plan, downstream tests should migrate to the real backend (or a properly typed stub). The shim can be removed or retained as a lighter alternative; that decision is made during implementation.

### Boot loader (`apps/api/src/store/boot.ts`)

```typescript
export async function bootStores(env: Env): Promise<Store> {
  const store = await openPublicStore(env.CFP_DATA_REPO_PATH);
  const privateStore = env.STORAGE_BACKEND === 's3'
    ? new S3PrivateStore(env)
    : new FilesystemPrivateStore(env);
  await privateStore.load();
  return new Store(store, privateStore);
}
```

Boot fails if either store is unreachable.

## Validation

- [x] All Zod schemas in `packages/shared/src/schemas/` round-trip against fixture records (one valid + one invalid per schema)
- [x] `zod-to-json-schema` build step keeps `.gitsheets/<sheet>.schema.json` files in sync; CI fails if drift
- [x] `npm test` includes a test that boots a `Store` against a `createTestRepo()` + `createTestPrivateStore()`, upserts a Project, queries it back, checks the path template rendered correctly
- [x] A test inserts a Person and writes a `PrivateProfile` for them via `store.transact`, then verifies both stores reflect the change
- [x] A test verifies cross-store transaction rollback: handler throws after public-side stage → no public commit, no private PUT
- [x] A test verifies dual-write semantics: handler succeeds but mock private PUT fails → public commit is rolled back via revert OR reconciliation hooks fire (decide which during implementation; document)
- [x] Markdown pipeline test: `renderMarkdown('# Hello\n[link](https://x.org)')` produces sanitized HTML and a plain-text excerpt
- [x] Markdown sanitizer rejects `<script>`, `javascript:`, `on*=`, raw HTML — covered by RFC-style negative tests
- [x] `createTestPrivateStore` shim in `apps/api/tests/helpers/test-private-store.ts` is evaluated: either migrated to use the real `FilesystemPrivateStore` or documented as intentionally retained as a lighter test fixture

## Risks / unknowns

- **Cross-store rollback strategy.** "Public committed, private failed" is the worst case. Options: (a) attempt to revert the public commit via `git revert`, (b) log loud and let reconciliation handle it. The spec accepts (b); flag (a) as an open implementation question.
- **JSON Schema generation accuracy.** `zod-to-json-schema` is decent but can lose information (refinements, transforms). Compensate by hand-editing schemas only on the Zod side, regenerating, and treating the JSON Schema as derived.
- **Push daemon at scale of one replica.** No coordination needed; running it is straightforward. Auth (deploy key) is wired in [`deploy`](deploy.md).

## Notes

- **Cross-store rollback chose option (b) — reconciliation.** `Store.transact()` uses public-first by default (for updates/deletes) and private-first for account creation. If the private flush fails after the public commit, the error is thrown loud and in-memory state is rolled back. No automatic `git revert` of the public commit is attempted. `apps/api/scripts/reconcile-private-store.ts` (not yet written, to be added in a downstream plan) is the recovery path. This matches spec decision in `private-storage.md`.

- **Zod v4 does not work with `zod-to-json-schema@3.25.2`.** The library recognizes the Zod v4 schema class but produces empty schema objects. Used Zod v4's built-in `toJSONSchema` instead (available as `import { toJSONSchema } from 'zod'`). The `zod-to-json-schema` dependency can be removed from `packages/shared` in a follow-up.

- **`$schema` field stripped from generated JSON Schemas.** Zod v4's `toJSONSchema` outputs `https://json-schema.org/draft/2020-12/schema` but gitsheets uses `ajv@8` in draft-07 mode, which rejects the 2020-12 URI. The schemas use only constructs compatible with both drafts, so stripping the field is safe.

- **`StandardSchemaV1` compatibility between Zod v4 and gitsheets.** TypeScript cannot prove that Zod v4's `Result<Output>` is assignable to gitsheets' `StandardSchemaResult<Output>` because of a structural mismatch in the `FailureResult` shape. A safe `as unknown as StandardSchemaV1` cast is used in `openPublicStore`. Both types are correct at runtime.

- **Sheet query after transact requires re-opening the sheet.** `openStore` / `openSheet` captures the git tree at call time. After a `transact` commit, calling `queryFirst` on the captured sheet returns pre-commit state. Tests and production code that need post-commit reads must call `repo.openSheet()` again. This is documented in gitsheets' internals (`#dataTree` is fixed at open time). See `store.test.ts` for the pattern.

- **`createTestPrivateStore` shim retained.** The original harness test in `apps/api/tests/harness.test.ts` still uses the shim via `TestPrivateStore` interface. The new store tests use the real `FilesystemPrivateStore` directly. The shim is lighter (no schema parsing, no transact machinery) and valid for simple fixture use. Downstream plans that add real mutation logic should use `FilesystemPrivateStore`.

- **Secondary in-memory indices not yet wired to `defineIndex`.** The spec describes using `Sheet.defineIndex` for per-sheet secondary indices. This plan establishes the store foundation; the indices (`bySlug.person`, `byLegacyId.person`, etc.) are described in `data-model.md` but not yet populated via `defineIndex` calls. They will be needed in the read-api/write-api plans when lookups happen. Deferred there.

- **`writeOrder: 'private-first'` orphan direction.** In private-first mode, `flushPrivate()` runs inside the `public.transact` callback before gitsheets commits. If private flush fails, the callback exits with an error and gitsheets does NOT commit the public tree — neither side is committed. However, if private flush succeeds but the callback subsequently throws (or gitsheets fails to commit for another reason), a private record without a matching public Person exists. This "private orphan without public" is the opposite direction from public-first failure. It is intentionally preferable for account creation: a private record without a public Person can be detected and cleaned up by the reconcile script, whereas a public Person without a private record (the public-first orphan) is harder to recover because the Person is visible to users without any associated email or auth data.

## Follow-ups

- Issue [#14](https://github.com/CodeForPhilly/codeforphilly-ng/issues/14) — Remove `zod-to-json-schema` from `packages/shared` dependencies (replaced by Zod v4's built-in `toJSONSchema`)
- Deferred to [write-api](write-api.md) — Wire `Sheet.defineIndex` calls for all secondary in-memory indices described in `data-model.md` (bySlug, byLegacyId, byGithubUserId, membershipsByPerson, etc.)
- Deferred to [write-api](write-api.md) — Implement `apps/api/scripts/reconcile-private-store.ts` for cross-store orphan detection/repair
