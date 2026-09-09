import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openRepo, openStore } from 'gitsheets';
import type { Repository, StandardSchemaV1, Store, StoreTx, ValidatorMap } from 'gitsheets';
import {
  BlogPostSchema,
  HelpWantedInterestExpressionSchema,
  HelpWantedRoleSchema,
  PersonSchema,
  ProjectBuzzSchema,
  ProjectMembershipSchema,
  ProjectSchema,
  ProjectUpdateSchema,
  RevocationSchema,
  SlugHistorySchema,
  TagAssignmentSchema,
  TagSchema,
} from '@cfp/shared/schemas';
import type {
  BlogPost,
  HelpWantedInterestExpression,
  HelpWantedRole,
  Person,
  ProjectBuzz,
  ProjectMembership,
  ProjectUpdate,
  Revocation,
  SlugHistory,
  Tag,
  TagAssignment,
} from '@cfp/shared/schemas';
import type { Project } from '@cfp/shared/schemas';

/**
 * Recursively drop `null` / `undefined`-valued keys from a record.
 *
 * gitsheets 2.x (Rust core) refuses to marshal `null` or `undefined` field
 * values — `serializeRecords`/`upsert` throw `cannot marshal JS value of type
 * Null/Undefined to a TOML value`. gitsheets 1.4.1 (`@iarna/toml`) silently
 * dropped such keys instead, so they were never written to disk: an absent
 * optional field is simply an absent TOML key (verified against the on-disk
 * `published` snapshot — no record carries a `null`-valued key).
 *
 * Our Zod schemas mark optional fields `.nullable().optional()` and the write
 * services normalize "cleared" fields to `?? null`. To keep the on-disk form
 * byte-identical to 1.4.1 (and to keep those `?? null` write paths working),
 * we strip null/undefined keys here, at the single write boundary, before the
 * record reaches the core marshaller. Nested tables (objects) are cleaned
 * recursively; arrays are passed through untouched (TOML has no null in
 * arrays, and our schemas never emit sparse arrays).
 *
 * `null` as an explicit "delete this field" signal only exists for
 * `Sheet.patch` (RFC 7396 merge-patch); we don't use `patch`, so stripping on
 * the full-record `upsert` path is unambiguous.
 */
function stripNullish(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripNullish(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

/**
 * Cast a Zod v4 schema to gitsheets' StandardSchemaV1, wrapping its validator
 * so the validated record has null/undefined-valued keys stripped before it
 * reaches gitsheets' core marshaller.
 *
 * gitsheets runs the Standard Schema validator host-side and marshals the
 * validator's *output* — so stripping here (rather than at every upsert call
 * site) is the single, authoritative write boundary. See `stripNullish`.
 *
 * Zod v4 implements the Standard Schema interface at runtime, but TypeScript
 * cannot prove that Zod's Result type is assignable to gitsheets' narrow
 * StandardSchemaResult because of a structural mismatch in the FailureResult
 * shape. Both are correct at runtime; the cast is safe.
 */
function asValidator<T extends Record<string, unknown>>(schema: unknown): StandardSchemaV1<unknown, T> {
  const inner = schema as StandardSchemaV1<unknown, T>;
  const innerValidate = inner['~standard'].validate;
  return {
    ...inner,
    '~standard': {
      ...inner['~standard'],
      validate: (value: unknown) => {
        const result = innerValidate(value);
        const strip = (
          r: Awaited<ReturnType<typeof innerValidate>>,
        ): Awaited<ReturnType<typeof innerValidate>> =>
          r.issues === undefined
            ? { value: stripNullish(r.value) as T }
            : r;
        return result instanceof Promise ? result.then(strip) : strip(result);
      },
    },
  };
}

/** Typed validator map for openStore. */
type PublicValidators = {
  readonly people: StandardSchemaV1<unknown, Person>;
  readonly projects: StandardSchemaV1<unknown, Project>;
  readonly 'project-memberships': StandardSchemaV1<unknown, ProjectMembership>;
  readonly 'project-updates': StandardSchemaV1<unknown, ProjectUpdate>;
  readonly 'project-buzz': StandardSchemaV1<unknown, ProjectBuzz>;
  readonly 'blog-posts': StandardSchemaV1<unknown, BlogPost>;
  readonly 'help-wanted-roles': StandardSchemaV1<unknown, HelpWantedRole>;
  readonly 'help-wanted-interest': StandardSchemaV1<unknown, HelpWantedInterestExpression>;
  readonly tags: StandardSchemaV1<unknown, Tag>;
  readonly 'tag-assignments': StandardSchemaV1<unknown, TagAssignment>;
  readonly 'slug-history': StandardSchemaV1<unknown, SlugHistory>;
  readonly revocations: StandardSchemaV1<unknown, Revocation>;
} & ValidatorMap;

export type PublicStore = Store<PublicValidators>;
export type PublicStoreTx = StoreTx<PublicValidators>;

/**
 * Open the gitsheets-backed public data store.
 *
 * `repoPath` is the **bare gitdir** — no `.git` subdirectory. The app
 * always operates against a bare clone per
 * specs/behaviors/storage.md → "The data clone is bare". A non-bare
 * repoPath fails loudly here so misconfiguration surfaces at boot
 * rather than as runtime drift between the API's HEAD and a stale
 * working tree.
 *
 * Reads `.gitsheets/<sheet>.toml` for each declared sheet. In-memory
 * secondary indices are built by the caller (boot.ts) after this
 * returns, since they require iterating over all records.
 *
 * Returns both the typed store and the underlying Repository handle —
 * the latter is needed by the push-daemon plugin to push commits to
 * origin.
 */
export async function openPublicStore(
  repoPath: string,
): Promise<{ store: PublicStore; repo: Repository }> {
  if (existsSync(join(repoPath, '.git'))) {
    throw new Error(
      `CFP_DATA_REPO_PATH=${repoPath} looks like a non-bare clone (found .git subdirectory). ` +
      `The app requires a bare clone — re-create with: git clone --bare <remote> ${repoPath}. ` +
      `See specs/behaviors/storage.md → "The data clone is bare".`,
    );
  }

  const repo = await openRepo({ gitDir: repoPath });
  repo.requireExplicitTransactions();

  const validators: PublicValidators = {
    people: asValidator<Person>(PersonSchema),
    projects: asValidator<Project>(ProjectSchema),
    'project-memberships': asValidator<ProjectMembership>(ProjectMembershipSchema),
    'project-updates': asValidator<ProjectUpdate>(ProjectUpdateSchema),
    'project-buzz': asValidator<ProjectBuzz>(ProjectBuzzSchema),
    'blog-posts': asValidator<BlogPost>(BlogPostSchema),
    'help-wanted-roles': asValidator<HelpWantedRole>(HelpWantedRoleSchema),
    'help-wanted-interest': asValidator<HelpWantedInterestExpression>(HelpWantedInterestExpressionSchema),
    tags: asValidator<Tag>(TagSchema),
    'tag-assignments': asValidator<TagAssignment>(TagAssignmentSchema),
    'slug-history': asValidator<SlugHistory>(SlugHistorySchema),
    revocations: asValidator<Revocation>(RevocationSchema),
  };

  const store = (await openStore(repo, { validators })) as PublicStore;
  return { store, repo };
}
