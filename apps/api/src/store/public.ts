import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openRepo, openStore } from 'gitsheets';
import type { Repository, Store, StoreTx, ValidatorMap } from 'gitsheets';
import {
  BlogPostSchema,
  HelpWantedInterestExpressionSchema,
  HelpWantedRoleSchema,
  PersonSchema,
  PersonEvaluationSchema,
  ProjectBuzzSchema,
  ProjectMembershipSchema,
  ProjectSchema,
  ProjectUpdateSchema,
  RevocationSchema,
  SlugHistorySchema,
  TagAssignmentSchema,
  TagSchema,
} from '@cfp/shared/schemas';

/**
 * The Zod schema backing each public sheet. One list for the store and for
 * the test that checks every sheet config's path template against its schema.
 */
export const PUBLIC_SHEET_SCHEMAS = {
  people: PersonSchema,
  projects: ProjectSchema,
  'project-memberships': ProjectMembershipSchema,
  'project-updates': ProjectUpdateSchema,
  'project-buzz': ProjectBuzzSchema,
  'blog-posts': BlogPostSchema,
  'help-wanted-roles': HelpWantedRoleSchema,
  'help-wanted-interest': HelpWantedInterestExpressionSchema,
  tags: TagSchema,
  'tag-assignments': TagAssignmentSchema,
  'slug-history': SlugHistorySchema,
  revocations: RevocationSchema,
  'person-evaluations': PersonEvaluationSchema,
} as const satisfies ValidatorMap;

/**
 * Validator map for openStore. Zod v4 schemas implement Standard Schema, so
 * gitsheets takes them as-is. gitsheets (≥ 2.3) drops null/undefined-valued
 * keys when marshalling, so a cleared optional field written as `null` is
 * simply an absent TOML key on disk.
 */
type PublicValidators = typeof PUBLIC_SHEET_SCHEMAS;

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
 * Reads `.gitsheets/<sheet>.toml` for each declared sheet. The in-memory
 * state (and its secondary indices) is loaded from the store later, by the
 * services plugin.
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

  const store = await openStore(repo, { validators: PUBLIC_SHEET_SCHEMAS });
  return { store, repo };
}
