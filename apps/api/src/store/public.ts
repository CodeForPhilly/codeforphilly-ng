import { openRepo, openStore } from 'gitsheets';
import type { StandardSchemaV1, Store, ValidatorMap } from 'gitsheets';
import {
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
 * Cast a Zod v4 schema to gitsheets' StandardSchemaV1.
 *
 * Zod v4 implements the Standard Schema interface at runtime, but TypeScript
 * cannot prove that Zod's Result type is assignable to gitsheets' narrow
 * StandardSchemaResult because of a structural mismatch in the FailureResult
 * shape. Both are correct at runtime; the cast is safe.
 */
function asValidator<T extends Record<string, unknown>>(schema: unknown): StandardSchemaV1<unknown, T> {
  return schema as StandardSchemaV1<unknown, T>;
}

/** Typed validator map for openStore. */
type PublicValidators = {
  readonly people: StandardSchemaV1<unknown, Person>;
  readonly projects: StandardSchemaV1<unknown, Project>;
  readonly 'project-memberships': StandardSchemaV1<unknown, ProjectMembership>;
  readonly 'project-updates': StandardSchemaV1<unknown, ProjectUpdate>;
  readonly 'project-buzz': StandardSchemaV1<unknown, ProjectBuzz>;
  readonly 'help-wanted-roles': StandardSchemaV1<unknown, HelpWantedRole>;
  readonly 'help-wanted-interest': StandardSchemaV1<unknown, HelpWantedInterestExpression>;
  readonly tags: StandardSchemaV1<unknown, Tag>;
  readonly 'tag-assignments': StandardSchemaV1<unknown, TagAssignment>;
  readonly 'slug-history': StandardSchemaV1<unknown, SlugHistory>;
  readonly revocations: StandardSchemaV1<unknown, Revocation>;
} & ValidatorMap;

export type PublicStore = Store<PublicValidators>;

/**
 * Open the gitsheets-backed public data store.
 *
 * Reads `.gitsheets/<sheet>.toml` for each declared sheet in `repoPath`.
 * In-memory secondary indices are built by the caller (boot.ts) after this
 * returns, since they require iterating over all records.
 */
export async function openPublicStore(repoPath: string): Promise<PublicStore> {
  const repo = await openRepo({ gitDir: `${repoPath}/.git`, workTree: repoPath });
  repo.requireExplicitTransactions();

  const validators: PublicValidators = {
    people: asValidator<Person>(PersonSchema),
    projects: asValidator<Project>(ProjectSchema),
    'project-memberships': asValidator<ProjectMembership>(ProjectMembershipSchema),
    'project-updates': asValidator<ProjectUpdate>(ProjectUpdateSchema),
    'project-buzz': asValidator<ProjectBuzz>(ProjectBuzzSchema),
    'help-wanted-roles': asValidator<HelpWantedRole>(HelpWantedRoleSchema),
    'help-wanted-interest': asValidator<HelpWantedInterestExpression>(HelpWantedInterestExpressionSchema),
    tags: asValidator<Tag>(TagSchema),
    'tag-assignments': asValidator<TagAssignment>(TagAssignmentSchema),
    'slug-history': asValidator<SlugHistory>(SlugHistorySchema),
    revocations: asValidator<Revocation>(RevocationSchema),
  };

  return openStore(repo, { validators }) as Promise<PublicStore>;
}
