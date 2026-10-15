/**
 * Scheduled spam purge — specs/behaviors/person-lifecycle.md → "Scheduled
 * spam purge": people whose human votes are all `spam`, the newest at least
 * three days old, still deactivated and not staff, are purged together in one
 * commit, with the projects only the batch touched.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { queuedForSpamPurge, spamPurgeDueAt } from '../src/services/spam-purge.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const execAsync = promisify(execFile);
const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const NOW = new Date('2026-10-20T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

const ID = {
  ringleader: '01951a3c-0000-7000-8000-a3000000cafe',
  sidekick: '01951a3c-0000-7000-8000-a4000000cafe',
  fresh: '01951a3c-0000-7000-8000-a5000000cafe',
  disputed: '01951a3c-0000-7000-8000-a6000000cafe',
  reactivated: '01951a3c-0000-7000-8000-a7000000cafe',
  staffer: '01951a3c-0000-7000-8000-a8000000cafe',
  ringProject: '01951a3c-0000-7000-8000-e9000000cafe',
};

describe('scheduled spam purge', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  async function seedPerson(slug: string, id: string, opts: { deactivated?: boolean; level?: string } = {}) {
    const toml = [
      `id = "${id}"`,
      `slug = "${slug}"`,
      `fullName = "Test ${slug}"`,
      `accountLevel = "${opts.level ?? 'user'}"`,
      ...(opts.deactivated === false ? [] : [`deletedAt = "${daysAgo(5)}"`]),
      `createdAt = "2026-05-01T00:00:00Z"`,
      `updatedAt = "2026-05-01T00:00:00Z"`,
    ].join('\n');
    await seedRawToml(dataRepo.path, `people/${slug}.toml`, toml, `seed ${slug}`);
  }

  async function seedVote(personSlug: string, voter: string, verdict: string, at: string) {
    const toml = [
      `personSlug = "${personSlug}"`,
      `evaluator = "human-${voter}"`,
      `verdict = "${verdict}"`,
      `confidence = 1`,
      `flags = []`,
      `evaluatedAt = "${at}"`,
    ].join('\n');
    await seedRawToml(dataRepo.path, `person-evaluations/${personSlug}/human-${voter}.toml`, toml, 'seed vote');
  }

  async function seedMember(projectSlug: string, personSlug: string, n: number) {
    const record = [
      `id = "01951a3c-0000-7000-8000-c${n}000000cafe"`,
      `projectSlug = "${projectSlug}"`,
      `personSlug = "${personSlug}"`,
      `isMaintainer = false`,
      `joinedAt = "2026-05-01T00:00:00Z"`,
      `updatedAt = "2026-05-01T00:00:00Z"`,
    ].join('\n');
    await seedRawToml(dataRepo.path, `project-memberships/${projectSlug}/${personSlug}.toml`, record, 'seed member');
  }

  const commitCount = async () =>
    Number((await execAsync('git', ['-C', dataRepo.path, 'rev-list', '--count', 'HEAD'])).stdout.trim());

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();

    await seedPerson('ringleader', ID.ringleader);
    await seedVote('ringleader', 'admin-user', 'spam', daysAgo(5));
    await seedPerson('sidekick', ID.sidekick);
    await seedVote('sidekick', 'admin-user', 'spam', daysAgo(4));
    await seedVote('sidekick', 'staff-user', 'spam', daysAgo(3.5));

    // Created by one queued spammer, joined only by another: goes with the batch.
    const project = [
      `id = "${ID.ringProject}"`,
      `slug = "ring-project"`,
      `title = "Ring project"`,
      `stage = "commenting"`,
      `createdById = "${ID.ringleader}"`,
      `maintainerId = "${ID.ringleader}"`,
      `createdAt = "2026-05-01T00:00:00Z"`,
      `updatedAt = "2026-05-01T00:00:00Z"`,
    ].join('\n');
    await seedRawToml(dataRepo.path, 'projects/ring-project.toml', project, 'seed project');
    await seedMember('ring-project', 'ringleader', 1);
    await seedMember('ring-project', 'sidekick', 2);

    await seedPerson('fresh', ID.fresh);
    await seedVote('fresh', 'admin-user', 'spam', daysAgo(1));
    await seedPerson('disputed', ID.disputed);
    await seedVote('disputed', 'admin-user', 'spam', daysAgo(10));
    await seedVote('disputed', 'staff-user', 'legit', daysAgo(9));
    await seedPerson('reactivated', ID.reactivated, { deactivated: false });
    await seedVote('reactivated', 'admin-user', 'spam', daysAgo(10));
    await seedPerson('staffer', ID.staffer, { level: 'staff' });
    await seedVote('staffer', 'admin-user', 'spam', daysAgo(10));

    app = await buildApp({
      serverOptions: { logger: false },
      overrideEnv: {
        CFP_DATA_REPO_PATH: dataRepo.path,
        STORAGE_BACKEND: 'filesystem',
        CFP_PRIVATE_STORAGE_PATH: privateStore.path,
        CFP_JWT_SIGNING_KEY: JWT_KEY,
        NODE_ENV: 'test',
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('queues only unopposed spam votes three or more days old on deactivated non-staff', () => {
    expect(queuedForSpamPurge(app.inMemoryState, NOW).map((p) => p.slug)).toEqual(['ringleader', 'sidekick']);

    // The roster's purgeAfter: three days after the newest vote, or null.
    const state = app.inMemoryState;
    const due = (slug: string) => spamPurgeDueAt(state, state.people.get(state.personIdBySlug.get(slug)!)!);
    expect(due('fresh')?.toISOString()).toBe(new Date(Date.parse(daysAgo(1)) + 3 * 24 * 60 * 60 * 1000).toISOString());
    expect(due('sidekick')?.toISOString()).toBe(new Date(Date.parse(daysAgo(3.5)) + 3 * 24 * 60 * 60 * 1000).toISOString());
    for (const slug of ['disputed', 'reactivated', 'staffer']) expect(due(slug), slug).toBeNull();
  });

  it('purges the whole queue, and projects only the batch touched, in one commit', async () => {
    const before = await commitCount();
    expect(await app.spamPurge.sweep(NOW)).toEqual(['ringleader', 'sidekick']);
    expect(await commitCount()).toBe(before + 1);

    const message = (await execAsync('git', ['-C', dataRepo.path, 'log', '-1', '--format=%an%n%B'])).stdout;
    expect(message).toContain('cfp-api');
    expect(message).toContain('scheduled spam purge (2)');
    expect(message).toContain('ringleader');

    const state = app.inMemoryState;
    expect(state.personIdBySlug.has('ringleader')).toBe(false);
    expect(state.personIdBySlug.has('sidekick')).toBe(false);
    expect(state.projectIdBySlug.has('ring-project')).toBe(false);
    for (const kept of ['fresh', 'disputed', 'reactivated', 'staffer']) {
      expect(state.personIdBySlug.has(kept), kept).toBe(true);
    }
  });

  it('writes nothing when nobody is queued', async () => {
    const before = await commitCount();
    expect(await app.spamPurge.sweep(NOW)).toEqual([]);
    expect(await commitCount()).toBe(before);
  });
});
