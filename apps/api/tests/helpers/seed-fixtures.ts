/**
 * Seed test fixtures into a full gitsheets data repo.
 *
 * Uses the raw gitsheets Repository (no validators) so we can pass in the
 * denormalized path fields that the sheet configs expect (e.g. projectSlug,
 * personSlug) alongside the canonical ID fields required by our Zod schemas.
 *
 * In production the write-api will construct these path fields from the
 * in-memory index at write time. Tests must do the same.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { openRepo } from 'gitsheets';

const execAsync = promisify(execFile);

/**
 * Write a raw TOML file into a bare gitsheets repo via a transient
 * working-tree clone. The bare-repo invariant
 * (specs/behaviors/storage.md → "The data clone is bare") rules out the
 * traditional `git add` / `git commit` flow against the data path — this
 * helper does the transient-clone-push dance once per call so test
 * fixtures can land arbitrary file shapes.
 *
 * `relPath` is the path within the working tree (e.g. `people/jane.toml`).
 * `commitMessage` is used verbatim; author/committer default to the
 * test identity.
 */
export async function seedRawToml(
  bareRepoPath: string,
  relPath: string,
  toml: string,
  commitMessage: string,
): Promise<void> {
  const wt = await mkdtemp(join(tmpdir(), 'cfp-seed-wt-'));
  try {
    await execAsync('git', ['clone', bareRepoPath, wt]);
    await execAsync('git', ['config', 'user.email', 'test@cfp.test'], { cwd: wt });
    await execAsync('git', ['config', 'user.name', 'cfp test'], { cwd: wt });
    await execAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: wt });
    await execAsync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: wt });

    const absPath = join(wt, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, toml);

    await execAsync('git', ['add', relPath], { cwd: wt });
    await execAsync('git', ['commit', '-m', commitMessage], { cwd: wt });
    await execAsync('git', ['push', 'origin', 'main'], { cwd: wt });
  } finally {
    // Linux ext4 + git background pack work can race the recursive rmdir
    // (ENOTEMPTY on `.git/objects/`). maxRetries gives the filesystem a
    // moment to settle. macOS APFS doesn't hit this; the retries are cheap.
    await rm(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * Sibling of `seedRawToml` for binary blobs (attachments, images, …).
 * Writes raw bytes at `relPath` and commits via the same transient
 * working-tree-clone-then-push dance.
 */
export async function seedRawBlob(
  bareRepoPath: string,
  relPath: string,
  bytes: Buffer,
  commitMessage: string,
): Promise<void> {
  const wt = await mkdtemp(join(tmpdir(), 'cfp-seed-wt-'));
  try {
    await execAsync('git', ['clone', bareRepoPath, wt]);
    await execAsync('git', ['config', 'user.email', 'test@cfp.test'], { cwd: wt });
    await execAsync('git', ['config', 'user.name', 'cfp test'], { cwd: wt });
    await execAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: wt });
    await execAsync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: wt });

    const absPath = join(wt, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, bytes);

    await execAsync('git', ['add', relPath], { cwd: wt });
    await execAsync('git', ['commit', '-m', commitMessage], { cwd: wt });
    await execAsync('git', ['push', 'origin', 'main'], { cwd: wt });
  } finally {
    await rm(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const NOW = '2026-05-01T00:00:00Z';
const NOW2 = '2026-05-10T00:00:00Z';

function uuid(n: number): string {
  return `01951a3c-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

export interface SeededFixtures {
  projectId: string;
  projectSlug: string;
  personId: string;
  personSlug: string;
  tagId: string;
  tagHandle: string;
  updateId: string;
  buzzId: string;
  helpWantedId: string;
}

/**
 * Seed a consistent set of fixture records into the given repo path.
 * Returns the IDs/slugs for use in assertions.
 */
export async function seedFixtures(repoPath: string): Promise<SeededFixtures> {
  const repo = await openRepo({ gitDir: repoPath });

  const projectId = uuid(1);
  const personId = uuid(2);
  const tagId = uuid(3);
  const membershipId = uuid(4);
  const updateId = uuid(5);
  const buzzId = uuid(6);
  const helpWantedId = uuid(7);
  const tagAssignmentProjectId = uuid(8);
  const tagAssignmentPersonId = uuid(9);

  const projectSlug = 'squadquest';
  const personSlug = 'jane-doe';
  const tagHandle = 'tech.flutter';

  await repo.transact(
    {
      message: 'seed: test fixtures',
      author: { name: 'test', email: 'test@cfp.test' },
    },
    async (tx) => {
      // Person
      await tx.sheet('people').upsert({
        id: personId,
        slug: personSlug,
        fullName: 'Jane Doe',
        firstName: 'Jane',
        lastName: 'Doe',
        bio: 'A civic technologist.',
        accountLevel: 'user',
        slackHandle: 'jane-doe',
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Project
      await tx.sheet('projects').upsert({
        id: projectId,
        slug: projectSlug,
        title: 'SquadQuest',
        summary: 'Realtime community events without Facebook.',
        overview: '## Overview\n\nSquadQuest is a civic app.',
        stage: 'testing',
        maintainerId: personId,
        featured: false,
        createdAt: NOW,
        updatedAt: NOW2,
      });

      // Tag (path: namespace/slug)
      await tx.sheet('tags').upsert({
        id: tagId,
        namespace: 'tech',
        slug: 'flutter',
        title: 'Flutter',
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Tag assignment: project → tag (path: tagId/taggableType/taggableId)
      await tx.sheet('tag-assignments').upsert({
        id: tagAssignmentProjectId,
        tagId,
        taggableType: 'project',
        taggableId: projectId,
        createdAt: NOW,
      });

      // Tag assignment: person → tag
      await tx.sheet('tag-assignments').upsert({
        id: tagAssignmentPersonId,
        tagId,
        taggableType: 'person',
        taggableId: personId,
        createdAt: NOW,
      });

      // Membership (path: projectSlug/personSlug)
      await tx.sheet('project-memberships').upsert({
        id: membershipId,
        projectId,
        personId,
        projectSlug,
        personSlug,
        role: 'Founder',
        isMaintainer: true,
        joinedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Project update (path: projectSlug/number)
      await tx.sheet('project-updates').upsert({
        id: updateId,
        projectId,
        authorId: personId,
        body: 'We shipped version 1.0!',
        number: 1,
        projectSlug,
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Project buzz (path: projectSlug/slug)
      await tx.sheet('project-buzz').upsert({
        id: buzzId,
        projectId,
        postedById: personId,
        slug: 'inquirer-praises-squadquest',
        headline: 'The Inquirer praises SquadQuest',
        url: 'https://www.inquirer.com/tech/squadquest-review',
        publishedAt: NOW,
        projectSlug,
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Help-wanted role (path: projectSlug/id)
      await tx.sheet('help-wanted-roles').upsert({
        id: helpWantedId,
        projectId,
        postedById: personId,
        title: 'Flutter developer',
        description: 'We need a Flutter expert.',
        commitmentHoursPerWeek: 4,
        status: 'open',
        projectSlug,
        createdAt: NOW,
        updatedAt: NOW,
      });
    },
  );

  return {
    projectId,
    projectSlug,
    personId,
    personSlug,
    tagId,
    tagHandle,
    updateId,
    buzzId,
    helpWantedId,
  };
}
