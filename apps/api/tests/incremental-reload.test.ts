/**
 * Incremental hot reload — specs/behaviors/storage.md → "Hot reload".
 *
 * The guard: after upstream commits that add, modify, rename and delete
 * records across the in-memory sheets, the incrementally updated live state
 * must deep-equal a full load of the new tree. Any secondary index only the
 * loader maintains would show up here as a mismatch.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openRepo } from 'gitsheets';

import { buildApp } from '../src/app.js';
import { loadInMemoryState } from '../src/store/memory/loader.js';
import { createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedFixtures, seedRawBlob, type SeededFixtures } from './helpers/seed-fixtures.js';
import { writeSheetConfigs } from './helpers/sheet-configs.js';

const exec = promisify(execFile);
const SECRET = 'test-reload-secret-at-least-32-chars-long!!';
const NOW = '2026-05-20T00:00:00Z';

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}

let root: string;
let bare: string;
let local: string;
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cfp-incremental-'));
  bare = join(root, 'remote.git');
  local = join(root, 'local.git');
  const seed = join(root, 'seed');

  await exec('git', ['init', '-b', 'main', seed]);
  for (const [k, v] of [
    ['user.email', 'seed@test.local'],
    ['user.name', 'seed'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '/dev/null'],
  ]) {
    await git(seed, 'config', k as string, v as string);
  }
  await writeSheetConfigs(seed);
  await git(seed, 'add', '.gitsheets');
  await git(seed, 'commit', '-m', 'initial: sheet configs');

  await exec('git', ['init', '--bare', '-b', 'main', bare]);
  await exec('git', ['push', bare, 'main'], { cwd: seed });
  await exec('git', ['clone', '--bare', bare, local]);
  await git(local, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await rm(seed, { recursive: true, force: true });

  privateStore = await createPrivateStorageDir();
  app = await buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: local,
      CFP_DATA_REMOTE: bare,
      CFP_DATA_BRANCH: 'main',
      CFP_DATA_RELOAD_SECRET: SECRET,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
      NODE_ENV: 'test',
    },
  });
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  await privateStore.cleanup();
  await rm(root, { recursive: true, force: true });
});

async function reload(): Promise<{ statusCode: number; reloadMode?: string }> {
  const res = await app!.inject({
    method: 'POST',
    url: '/api/_internal/reload-data',
    headers: { authorization: `Bearer ${SECRET}` },
    payload: { commitHash: await git(bare, 'rev-parse', 'main') },
  });
  const body = res.json<{ data?: { reloadMode?: string } }>();
  return { statusCode: res.statusCode, reloadMode: body.data?.reloadMode };
}

async function expectEqualsFullLoad(): Promise<void> {
  const full = await loadInMemoryState(app!.store.public);
  expect(app!.inMemoryState).toEqual(full);
}

/** Upstream edits across every in-memory sheet: rename, modify, delete, add. */
async function editUpstream(f: SeededFixtures): Promise<void> {
  const repo = await openRepo({ gitDir: bare });
  await repo.transact(
    { message: 'upstream: edits', author: { name: 'test', email: 'test@cfp.test' } },
    async (tx) => {
      // Rename + retitle the project.
      const projects = tx.sheet('projects');
      const [project] = (await projects.queryAll()) as Array<Record<string, unknown>>;
      await projects.delete(project!);
      await projects.upsert({ ...project, slug: 'squadquest-two', title: 'SquadQuest Two' });

      // Modify the person; add a second one.
      const people = tx.sheet('people');
      const [person] = (await people.queryAll()) as Array<Record<string, unknown>>;
      await people.upsert({ ...person, bio: 'Changed upstream.' });
      await people.upsert({
        id: '01951a3c-0000-7000-8000-0000000000f1',
        slug: 'new-person',
        fullName: 'New Person',
        accountLevel: 'user',
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Delete every membership and buzz item.
      for (const sheet of ['project-memberships', 'project-buzz'] as const) {
        const s = tx.sheet(sheet);
        for (const r of (await s.queryAll()) as Array<Record<string, unknown>>) await s.delete(r);
      }

      // Retitle the help-wanted role; retitle the tag.
      const roles = tx.sheet('help-wanted-roles');
      for (const r of (await roles.queryAll()) as Array<Record<string, unknown>>) {
        await roles.upsert({ ...r, title: 'Retitled role', projectSlug: 'squadquest-two' });
      }
      const tags = tx.sheet('tags');
      const [tag] = (await tags.queryAll()) as Array<Record<string, unknown>>;
      await tags.upsert({ ...tag, title: 'Flutter (retitled)' });

      // Drop one tag assignment.
      const assignments = tx.sheet('tag-assignments');
      const [ta] = (await assignments.queryAll()) as Array<Record<string, unknown>>;
      await assignments.delete(ta!);

      // Slug history for the rename, and a spam vote.
      await tx.sheet('slug-history').upsert({
        id: '01951a3c-0000-7000-8000-0000000000f2',
        entityType: 'project',
        oldSlug: f.projectSlug,
        newSlug: 'squadquest-two',
        entityId: f.projectId,
        changedAt: NOW,
        expiresAt: '2099-01-01T00:00:00Z',
      });
      await tx.sheet('person-evaluations').upsert({
        personSlug: 'new-person',
        evaluator: 'human-jane-doe',
        verdict: 'legit',
        flags: [],
        evaluatedAt: NOW,
      });
    },
  );
}

describe('incremental hot reload', () => {
  it('matches a full load after upstream adds, edits, renames and deletes', async () => {
    const fixtures = await seedFixtures(bare);
    const added = await reload();
    expect(added).toEqual({ statusCode: 200, reloadMode: 'incremental' });
    await expectEqualsFullLoad();
    expect(app!.inMemoryState.projects.size).toBe(1);

    await editUpstream(fixtures);
    const edited = await reload();
    expect(edited).toEqual({ statusCode: 200, reloadMode: 'incremental' });
    await expectEqualsFullLoad();

    // Search follows the rename; the old slug is gone from the index.
    expect(app!.fts.searchProjects('SquadQuest')).toEqual(['squadquest-two']);
    expect(app!.fts.searchPeople('Changed')).toEqual([fixtures.personSlug]);
    expect(app!.fts.searchHelpWanted('Retitled')).toEqual([fixtures.helpWantedId]);

    // A record that arrived incrementally can still be written through
    // gitsheets: delete locates it by its path annotation.
    const project = app!.inMemoryState.projects.get(fixtures.projectId)!;
    await app!.store.public.transact(
      { message: 'test: delete reloaded project', author: { name: 'test', email: 'test@cfp.test' } },
      async (tx) => {
        await tx.projects.delete(project);
      },
    );
    expect(await git(local, 'ls-tree', '--name-only', 'HEAD', 'projects/')).toBe('');
  });

  it('falls back to a full rebuild when a sheet config changes', async () => {
    await seedFixtures(bare);
    const config = await git(bare, 'show', 'main:.gitsheets/people.toml');
    await seedRawBlob(
      bare,
      '.gitsheets/people.toml',
      Buffer.from(`${config}\n# touched\n`),
      'upstream: touch a sheet config',
    );

    const res = await reload();
    expect(res).toEqual({ statusCode: 200, reloadMode: 'full' });
    await expectEqualsFullLoad();
  });
});
