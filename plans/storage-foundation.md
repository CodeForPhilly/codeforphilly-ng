---
status: planned
depends: [test-harness]
specs:
  - specs/data-model.md
  - specs/behaviors/storage.md
  - specs/behaviors/private-storage.md
  - specs/behaviors/path-templates.md
  - specs/behaviors/transactions.md
  - specs/behaviors/validation.md
  - specs/behaviors/normalization.md
  - specs/behaviors/markdown-rendering.md
issues: []
---

# Plan: Storage foundation

## Scope

The data layer: Zod schemas for every entity, the gitsheets-backed public store, the bucket-backed private store, in-memory representation, secondary indexes, and the markdown rendering pipeline. **Assumes [gitsheets v1.0](https://github.com/JarvusInnovations/gitsheets/milestone/1) has shipped** — we consume its TypeScript API directly (Repository, Sheet, Transaction, openStore).

Out of scope: HTTP surface (next plan), authorization rules (referenced but enforced in `write-api`), full-text search index (built in `read-api` once we have records to index), markdown editor in the UI (`web-shell` / `authoring-screens`).

## Implements

- [data-model.md](../specs/data-model.md) — every entity gets a Zod schema and Sheet declaration. The public/private split is realized via the two stores.
- [behaviors/storage.md](../specs/behaviors/storage.md) — gitsheets repo, single-replica process model, in-memory state + secondary indices, sync-to-GitHub via gitsheets push daemon, the commit-message format including pseudonymous author and trailer policy.
- [behaviors/private-storage.md](../specs/behaviors/private-storage.md) — `PrivateStore` interface; S3 and filesystem backends; boot-load; PUT-on-mutation; dual-write coordination helper.
- [behaviors/path-templates.md](../specs/behaviors/path-templates.md) — handled by gitsheets v1.0 itself; this plan just declares the `path` config in each `.gitsheets/<sheet>.toml`.
- [behaviors/transactions.md](../specs/behaviors/transactions.md) — public mutations flow through `repo.transact`; the private-side companion is `PrivateStore.transact` (own minimal mutex). Cross-store coordination happens at a higher level (`Store.transact`).
- [behaviors/validation.md](../specs/behaviors/validation.md) — Zod schemas in `packages/shared` attached as Standard Schema validators via `openStore({ validators })`. `.gitsheets/<sheet>.toml` carries the JSON Schema persisted contract.
- [behaviors/normalization.md](../specs/behaviors/normalization.md) — gitsheets v1.0 handles array `sort` config + key sorting natively; we declare what we need.
- [behaviors/markdown-rendering.md](../specs/behaviors/markdown-rendering.md) — `renderMarkdown(source): { html, excerpt }` utility in `packages/shared` (server-side rendering via unified/remark/rehype-sanitize).

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

Where each `.gitsheets/schemas/<Entity>.schema.json` is JSON Schema generated from the Zod schema via `zod-to-json-schema` at build time. (Generated file; committed; CI verifies it's in sync with the Zod source.)

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

- [ ] All Zod schemas in `packages/shared/src/schemas/` round-trip against fixture records (one valid + one invalid per schema)
- [ ] `zod-to-json-schema` build step keeps `.gitsheets/<sheet>.schema.json` files in sync; CI fails if drift
- [ ] `npm test` includes a test that boots a `Store` against a `createTestRepo()` + `createTestPrivateStore()`, upserts a Project, queries it back, checks the path template rendered correctly
- [ ] A test inserts a Person and writes a `PrivateProfile` for them via `store.transact`, then verifies both stores reflect the change
- [ ] A test verifies cross-store transaction rollback: handler throws after public-side stage → no public commit, no private PUT
- [ ] A test verifies dual-write semantics: handler succeeds but mock private PUT fails → public commit is rolled back via revert OR reconciliation hooks fire (decide which during implementation; document)
- [ ] Markdown pipeline test: `renderMarkdown('# Hello\n[link](https://x.org)')` produces sanitized HTML and a plain-text excerpt
- [ ] Markdown sanitizer rejects `<script>`, `javascript:`, `on*=`, raw HTML — covered by RFC-style negative tests

## Risks / unknowns

- **Cross-store rollback strategy.** "Public committed, private failed" is the worst case. Options: (a) attempt to revert the public commit via `git revert`, (b) log loud and let reconciliation handle it. The spec accepts (b); flag (a) as an open implementation question.
- **JSON Schema generation accuracy.** `zod-to-json-schema` is decent but can lose information (refinements, transforms). Compensate by hand-editing schemas only on the Zod side, regenerating, and treating the JSON Schema as derived.
- **Push daemon at scale of one replica.** No coordination needed; running it is straightforward. Auth (deploy key) is wired in [`deploy`](deploy.md).

## Notes
