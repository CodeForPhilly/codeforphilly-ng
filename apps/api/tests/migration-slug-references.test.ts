/**
 * Migration: child records reference path-keyed parents by slug
 * (scripts/migrations/202610150400-slug-references.ts).
 *
 * Fixtures are old-shape records written as raw TOML (ids alongside the
 * slugs the old write services injected) on a repo whose sheet configs
 * already declare the v2 contracts, as the data repo will once adopted.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openRepo } from 'gitsheets';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MIGRATED_SHEETS,
  MigrationError,
  migrateSlugReferences,
} from '../scripts/migrations/202610150400-slug-references.js';
import { loadInMemoryState } from '../src/store/memory/loader.js';
import { openPublicStore } from '../src/store/public.js';
import { createFullDataRepo } from './helpers/test-full-repo.js';

const exec = promisify(execFile);
const GITSHEETS_CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '.bin', 'gitsheets');

const NOW = '2026-05-15T18:42:00Z';
const ID = {
  jane: '01951a3c-0000-7000-8000-000000000001',
  bob: '01951a3c-0000-7000-8000-000000000002',
  project: '01951a3c-0000-7000-8000-000000000003',
  event: '01951a3c-0000-7000-8000-000000000004',
  membership: '01951a3c-0000-7000-8000-000000000005',
  update: '01951a3c-0000-7000-8000-000000000006',
  buzz: '01951a3c-0000-7000-8000-000000000007',
  role: '01951a3c-0000-7000-8000-000000000008',
  interest: '01951a3c-0000-7000-8000-000000000009',
  rsvp: '01951a3c-0000-7000-8000-00000000000a',
};
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

let data: { path: string; cleanup: () => Promise<void> };

async function git(...args: string[]): Promise<string> {
  return (await exec('git', ['--git-dir', data.path, ...args])).stdout.trim();
}

/** Commit raw files onto main in one commit (bypassing gitsheets validation). */
async function seedFiles(files: Record<string, string | Buffer>, message: string): Promise<void> {
  const wt = await mkdtemp(join(tmpdir(), 'cfp-migrate-wt-'));
  try {
    const run = (...args: string[]) => exec('git', args, { cwd: wt });
    await exec('git', ['clone', '--no-local', data.path, wt]);
    await run('config', 'user.email', 'test@cfp.test');
    await run('config', 'user.name', 'cfp test');
    await run('config', 'commit.gpgsign', 'false');
    await run('config', 'core.hooksPath', '/dev/null');
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(wt, rel)), { recursive: true });
      await writeFile(join(wt, rel), content);
      await run('add', rel);
    }
    await run('commit', '-m', message);
    await run('push', 'origin', 'main');
  } finally {
    await rm(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const toml = (fields: Record<string, string | number | boolean>): string =>
  `${Object.entries(fields)
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
    .join('\n')}\n`;

/** Parents through gitsheets; old-shape children as raw files. */
async function seedOldShape(overrides: Record<string, string | Buffer> = {}): Promise<void> {
  const repo = await openRepo({ gitDir: data.path });
  await repo.transact({ message: 'seed parents', author: { name: 't', email: 't@cfp.test' } }, async (tx) => {
    for (const [id, slug] of [[ID.jane, 'jane'], [ID.bob, 'bob']] as const) {
      await tx.sheet('people').upsert({ id, slug, fullName: slug, accountLevel: 'user', createdAt: NOW, updatedAt: NOW });
    }
    await tx.sheet('projects').upsert({
      id: ID.project, slug: 'proj', title: 'Proj', stage: 'bootstrapping', maintainerId: ID.jane,
      createdAt: NOW, updatedAt: NOW,
    });
    await tx.sheet('events').upsert(
      {
        id: ID.event, slug: 'hack-night', title: 'Hack Night', startsAt: '2026-06-01T23:00:00Z',
        endsAt: '2026-06-02T01:00:00Z', status: 'scheduled', icsSequence: 0, createdAt: NOW, updatedAt: NOW,
      },
      { allowMissingBody: true },
    );
  });

  await seedFiles(
    {
      'project-memberships/proj/jane.toml': toml({
        id: ID.membership, projectId: ID.project, personId: ID.jane, projectSlug: 'proj', personSlug: 'jane',
        isMaintainer: true, joinedAt: NOW, createdAt: NOW, updatedAt: NOW,
      }),
      'project-updates/proj/1.toml': toml({
        id: ID.update, projectId: ID.project, projectSlug: 'proj', authorId: ID.jane, body: 'Shipped',
        number: 1, createdAt: NOW, updatedAt: NOW,
      }),
      'project-buzz/proj/press.toml': toml({
        id: ID.buzz, projectId: ID.project, projectSlug: 'proj', slug: 'press', headline: 'Press',
        url: 'https://example.org/press', publishedAt: NOW, imageKey: 'project-buzz/proj/press/image.png',
        createdAt: NOW, updatedAt: NOW,
      }),
      'project-buzz/proj/press/image.png': IMAGE,
      [`help-wanted-roles/proj/${ID.role}.toml`]: toml({
        id: ID.role, projectId: ID.project, projectSlug: 'proj', postedById: ID.jane, title: 'Dev',
        description: 'Help', status: 'open', createdAt: NOW, updatedAt: NOW,
      }),
      [`help-wanted-interest/${ID.role}/bob.toml`]: toml({
        id: ID.interest, roleId: ID.role, personId: ID.bob, personSlug: 'bob', createdAt: NOW,
      }),
      // No year / eventSlug on disk: both come from the event, via eventId.
      'event-rsvps/2026/hack-night/bob.toml': toml({
        id: ID.rsvp, eventId: ID.event, personId: ID.bob, personSlug: 'bob', plan: 'project',
        projectId: ID.project, createdAt: NOW, updatedAt: NOW,
      }),
      ...overrides,
    },
    'seed old-shape child records',
  );
}

beforeEach(async () => {
  data = await createFullDataRepo();
});

afterEach(async () => {
  await data.cleanup();
});

describe('slug-references migration', () => {
  it('rewrites every old-shape record to slug references and drops the ids', async () => {
    await seedOldShape();
    const result = await migrateSlugReferences({ dataRepo: data.path, branch: 'main' });

    expect(result.commitHash).toBe(await git('rev-parse', 'main'));
    expect(result.scanned).toEqual(Object.fromEntries(MIGRATED_SHEETS.map((s) => [s, 1])));
    expect(result.rewritten).toEqual(Object.fromEntries(MIGRATED_SHEETS.map((s) => [s, 1])));

    const membership = await git('show', 'main:project-memberships/proj/jane.toml');
    expect(membership).toContain('projectSlug = "proj"');
    expect(membership).toContain('personSlug = "jane"');
    expect(membership).not.toMatch(/projectId|personId/);
    for (const path of ['project-updates/proj/1.toml', 'project-buzz/proj/press.toml', `help-wanted-roles/proj/${ID.role}.toml`]) {
      expect(await git('show', `main:${path}`), path).not.toContain('projectId');
    }
    expect(await git('show', `main:help-wanted-interest/${ID.role}/bob.toml`)).not.toContain('personId');

    const rsvp = await git('show', 'main:event-rsvps/2026/hack-night/bob.toml');
    expect(rsvp).toContain('year = "2026"');
    expect(rsvp).toContain('eventSlug = "hack-night"');
    expect(rsvp).not.toMatch(/eventId|personId/);
    // The RSVP's "coming to work on" project is not a path reference: it stays.
    expect(rsvp).toContain(`projectId = "${ID.project}"`);

    // The buzz image is untouched.
    expect((await exec('git', ['--git-dir', data.path, 'cat-file', '-s', 'main:project-buzz/proj/press/image.png'])).stdout.trim())
      .toBe(String(IMAGE.length));

    // The migrated tree opens against the v2 contracts and loads.
    const { store } = await openPublicStore(data.path);
    const state = await loadInMemoryState(store);
    expect([...(state.membershipsByProject.get('proj') ?? [])]).toEqual([ID.membership]);
    expect([...(state.rsvpsByEvent.get('hack-night') ?? [])]).toEqual([ID.rsvp]);

    // gitsheets' own conformance gate agrees.
    await exec(GITSHEETS_CLI, ['contracts', 'verify', '--git-dir', data.path, '--ref', 'main']);
  });

  it('is idempotent: a second run writes nothing', async () => {
    await seedOldShape();
    const first = await migrateSlugReferences({ dataRepo: data.path, branch: 'main' });
    const second = await migrateSlugReferences({ dataRepo: data.path, branch: 'main' });
    expect(second.commitHash).toBeNull();
    expect(second.rewritten).toEqual(Object.fromEntries(MIGRATED_SHEETS.map((s) => [s, 0])));
    expect(await git('rev-parse', 'main')).toBe(first.commitHash);
  });

  it('a dry run reports without writing', async () => {
    await seedOldShape();
    const before = await git('rev-parse', 'main');
    const result = await migrateSlugReferences({ dataRepo: data.path, branch: 'main', dryRun: true });
    expect(result.commitHash).toBeNull();
    expect(result.rewritten['project-memberships']).toBe(1);
    expect(await git('rev-parse', 'main')).toBe(before);
  });

  it('refuses to write anything when a reference does not resolve, listing each', async () => {
    await seedOldShape({
      // A stale stored slug (a person rename that never cascaded): its id
      // still resolves, so the message names the current slug.
      'project-memberships/proj/bob-old.toml': toml({
        id: '01951a3c-0000-7000-8000-0000000000b1', projectId: ID.project, personId: ID.bob,
        projectSlug: 'proj', personSlug: 'bob-old', isMaintainer: false, joinedAt: NOW, createdAt: NOW, updatedAt: NOW,
      }),
      // A record whose parent is gone entirely.
      'project-updates/gone/1.toml': toml({
        id: '01951a3c-0000-7000-8000-0000000000b2', projectId: '01951a3c-0000-7000-8000-0000000000ff',
        projectSlug: 'gone', body: 'Orphan', number: 1, createdAt: NOW, updatedAt: NOW,
      }),
    });
    const before = await git('rev-parse', 'main');

    const err = await migrateSlugReferences({ dataRepo: data.path, branch: 'main' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationError);
    const problems = (err as MigrationError).problems;
    expect(problems).toHaveLength(2);
    expect(problems).toContainEqual(
      "project-memberships/proj/bob-old: personSlug='bob-old' does not resolve in people (its id resolves to 'bob')",
    );
    expect(problems).toContainEqual("project-updates/gone/1: projectSlug='gone' does not resolve in projects");
    expect(await git('rev-parse', 'main')).toBe(before);
  });

  it('refuses a branch whose sheets do not declare the v2 contracts', async () => {
    await seedOldShape({
      '.gitsheets/project-memberships.toml':
        "[gitsheet]\nroot = 'project-memberships'\npath = '${{ projectSlug }}/${{ personSlug }}'\nimplements = [\"codeforphilly.org/project-memberships/v1\"]\n",
    });
    await expect(migrateSlugReferences({ dataRepo: data.path, branch: 'main' })).rejects.toThrow(
      /project-memberships declares \[codeforphilly.org\/project-memberships\/v1\], not codeforphilly.org\/project-memberships\/v2/,
    );
  });
});
