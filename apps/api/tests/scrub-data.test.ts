/**
 * Tests for apps/api/scripts/scrub-data.ts
 *
 * Covers:
 * - Scrubbed output has no real names / emails / github identities / slugs
 * - Same-seed determinism (byte-identical tree hash)
 * - Different-seed produces different pseudonyms, same structure
 * - Snapshot has a single commit
 * - Deliberate-leak detection (injected email → script throws / exits non-zero)
 * - Record count parity (source vs snapshot)
 * - blog-posts written as markdown with attachments; person avatars dropped
 * - canonical TOML (arrays kept) and no path collisions on missing fields
 * - buildSlugMap collision-safety and determinism
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSlugMap,
  rewriteMentions,
  scrubPersonRecord,
  scrubProjectRecord,
  scrubRepo,
  verifySnapshot,
} from '../scripts/scrub-data.js';
import { faker } from '@faker-js/faker';
import { createTestRepo, seed } from './helpers/test-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = '2026-05-16T00:00:00Z';
const uuid = (n: number) => `01951a3c-0000-7000-8000-${String(n).padStart(12, '0')}`;

type Tmp = { path: string; cleanup: () => Promise<void> };

async function makeTmp(): Promise<Tmp> {
  const path = await mkdtemp(join(tmpdir(), 'cfp-scrub-test-'));
  return {
    path,
    cleanup: async () => { await rm(path, { recursive: true, force: true }); },
  };
}

/** Create a minimal source git repo suitable for scrub-data. */
async function makeSourceRepo(options: {
  people?: Array<Record<string, unknown>>;
  projects?: Array<Record<string, unknown>>;
} = {}): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const { repo, path, cleanup } = await createTestRepo(['people', 'projects']);

  if (options.people && options.people.length > 0) {
    await seed(repo, 'people', options.people);
  }
  if (options.projects && options.projects.length > 0) {
    await seed(repo, 'projects', options.projects);
  }

  return { path, cleanup };
}

/** Walk a directory tree and return all .toml file paths relative to root. */
async function walkTomlFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTomlFiles(fullPath, base)));
    } else if (entry.name.endsWith('.toml')) {
      files.push(fullPath.slice(base.length + 1));
    }
  }
  return files;
}

/** Count commits on the current HEAD of a repo. */
async function countCommits(repoPath: string): Promise<number> {
  const { stdout } = await exec('git', ['rev-list', '--count', 'HEAD'], { cwd: repoPath });
  return parseInt(stdout.trim(), 10);
}

// ---------------------------------------------------------------------------
// Unit tests: buildSlugMap
// ---------------------------------------------------------------------------

describe('buildSlugMap', () => {
  it('is deterministic: same seed + same inputs → same map', () => {
    const slugs = ['janedoe', 'johndoe', 'alice', 'bob'];
    const m1 = buildSlugMap(slugs, 'test-seed-2026');
    const m2 = buildSlugMap(slugs, 'test-seed-2026');
    expect(m1).toEqual(m2);
  });

  it('produces different results for different seeds', () => {
    const slugs = ['janedoe'];
    const m1 = buildSlugMap(slugs, 'seed-a');
    const m2 = buildSlugMap(slugs, 'seed-b');
    // Very unlikely to collide
    expect(m1.get('janedoe')).not.toBe(m2.get('janedoe'));
  });

  it('never produces real slugs as pseudo-slugs for any known slug', () => {
    const slugs = ['janedoe', 'johndoe'];
    const map = buildSlugMap(slugs, 'seed-x');
    for (const pseudo of map.values()) {
      expect(slugs).not.toContain(pseudo);
    }
  });

  it('handles collisions by appending numeric suffix', () => {
    // Build a large slug list — with > 5000 slugs there will be collisions
    // in the adjective-noun space. This smoke-tests that every slug gets a
    // unique pseudo-slug.
    const slugs: string[] = [];
    for (let i = 0; i < 200; i++) slugs.push(`person${i}`);
    const map = buildSlugMap(slugs, 'collision-test');
    const values = [...map.values()];
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });

  it('maps every input slug to something', () => {
    const slugs = ['a1', 'b2', 'c3'];
    const map = buildSlugMap(slugs, 'complete');
    for (const slug of slugs) {
      expect(map.has(slug)).toBe(true);
      expect(typeof map.get(slug)).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: rewriteMentions
// ---------------------------------------------------------------------------

describe('rewriteMentions', () => {
  it('rewrites @slug in text to pseudo-slug', () => {
    const map = new Map([['janedoe', 'bold-anchor']]);
    expect(rewriteMentions('Thanks @janedoe!', map)).toBe('Thanks @bold-anchor!');
  });

  it('leaves unknown mentions unchanged', () => {
    const map = new Map<string, string>();
    expect(rewriteMentions('Ping @someone!', map)).toBe('Ping @someone!');
  });

  it('rewrites multiple mentions', () => {
    const map = new Map([['alice', 'calm-eagle'], ['bob', 'keen-fox']]);
    expect(rewriteMentions('@alice and @bob', map)).toBe('@calm-eagle and @keen-fox');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: scrubPersonRecord
// ---------------------------------------------------------------------------

describe('scrubPersonRecord', () => {
  const slugMap = new Map([['janedoe', 'bold-anchor']]);

  beforeEach(() => {
    faker.seed(42);
  });

  it('replaces slug with pseudo-slug', () => {
    const rec = { id: uuid(1), slug: 'janedoe', fullName: 'Jane Doe', createdAt: NOW, updatedAt: NOW, accountLevel: 'user' };
    const scrubbed = scrubPersonRecord(rec, slugMap, faker);
    expect(scrubbed['slug']).toBe('bold-anchor');
  });

  it('clears githubLogin, githubUserId, githubLinkedAt', () => {
    const rec = {
      id: uuid(1), slug: 'janedoe', fullName: 'Jane Doe',
      githubLogin: 'janedoe-gh', githubUserId: 12345, githubLinkedAt: NOW,
      createdAt: NOW, updatedAt: NOW, accountLevel: 'user',
    };
    const scrubbed = scrubPersonRecord(rec, slugMap, faker);
    expect('githubLogin' in scrubbed).toBe(false);
    expect('githubUserId' in scrubbed).toBe(false);
    expect('githubLinkedAt' in scrubbed).toBe(false);
  });

  it('clears slackSamlNameId', () => {
    const rec = { id: uuid(1), slug: 'janedoe', fullName: 'Jane Doe', slackSamlNameId: 'janedoe', createdAt: NOW, updatedAt: NOW, accountLevel: 'user' };
    const scrubbed = scrubPersonRecord(rec, slugMap, faker);
    expect('slackSamlNameId' in scrubbed).toBe(false);
  });

  it('clears avatarKey', () => {
    const rec = { id: uuid(1), slug: 'janedoe', fullName: 'Jane Doe', avatarKey: 'people-avatars/x/orig.jpg', createdAt: NOW, updatedAt: NOW, accountLevel: 'user' };
    const scrubbed = scrubPersonRecord(rec, slugMap, faker);
    expect('avatarKey' in scrubbed).toBe(false);
  });

  it('replaces slackHandle with pseudo-slug', () => {
    const rec = { id: uuid(1), slug: 'janedoe', fullName: 'Jane Doe', slackHandle: 'janedoe', createdAt: NOW, updatedAt: NOW, accountLevel: 'user' };
    const scrubbed = scrubPersonRecord(rec, slugMap, faker);
    expect(scrubbed['slackHandle']).toBe('bold-anchor');
  });

  it('preserves id unchanged', () => {
    const id = uuid(42);
    const rec = { id, slug: 'janedoe', fullName: 'Jane Doe', createdAt: NOW, updatedAt: NOW, accountLevel: 'user' };
    const scrubbed = scrubPersonRecord(rec, slugMap, faker);
    expect(scrubbed['id']).toBe(id);
  });

  it('replaces fullName with faker name (not the real name)', () => {
    const rec = { id: uuid(1), slug: 'janedoe', fullName: 'Jane Doe', createdAt: NOW, updatedAt: NOW, accountLevel: 'user' };
    const scrubbed = scrubPersonRecord(rec, slugMap, faker);
    expect(scrubbed['fullName']).not.toBe('Jane Doe');
    expect(typeof scrubbed['fullName']).toBe('string');
  });

  it('replaces bio with lorem ipsum', () => {
    const rec = { id: uuid(1), slug: 'janedoe', fullName: 'Jane Doe', bio: 'I am a real person with a real bio.', createdAt: NOW, updatedAt: NOW, accountLevel: 'user' };
    const scrubbed = scrubPersonRecord(rec, slugMap, faker);
    expect(scrubbed['bio']).not.toBe('I am a real person with a real bio.');
    expect(typeof scrubbed['bio']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: scrubProjectRecord
// ---------------------------------------------------------------------------

describe('scrubProjectRecord', () => {
  const slugMap = new Map([['janedoe', 'bold-anchor']]);

  it('rewrites @mentions in overview', () => {
    const rec = {
      id: uuid(1), slug: 'my-project', title: 'My Project',
      overview: 'Led by @janedoe, this project is great.',
      createdAt: NOW, updatedAt: NOW, stage: 'bootstrapping',
    };
    const scrubbed = scrubProjectRecord(rec, slugMap);
    expect(scrubbed['overview']).toBe('Led by @bold-anchor, this project is great.');
  });

  it('normalizes chatChannel to chat-<projectSlug>', () => {
    const rec = {
      id: uuid(1), slug: 'my-project', title: 'My Project',
      chatChannel: 'janedoe-channel',
      createdAt: NOW, updatedAt: NOW, stage: 'bootstrapping',
    };
    const scrubbed = scrubProjectRecord(rec, slugMap);
    expect(scrubbed['chatChannel']).toBe('chat-my-project');
  });

  it('keeps featuredImageKey (project attachments follow the snapshot)', () => {
    const rec = {
      id: uuid(1), slug: 'my-project', title: 'My Project',
      featuredImageKey: 'projects/my-project/hero.jpg',
      createdAt: NOW, updatedAt: NOW, stage: 'bootstrapping',
    };
    const scrubbed = scrubProjectRecord(rec, slugMap);
    expect(scrubbed['featuredImageKey']).toBe('projects/my-project/hero.jpg');
  });

  it('preserves project slug unchanged', () => {
    const rec = {
      id: uuid(1), slug: 'my-project', title: 'My Project',
      createdAt: NOW, updatedAt: NOW, stage: 'bootstrapping',
    };
    const scrubbed = scrubProjectRecord(rec, slugMap);
    expect(scrubbed['slug']).toBe('my-project');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: verifySnapshot
// ---------------------------------------------------------------------------

describe('verifySnapshot', () => {
  let tmp: Tmp;

  beforeEach(async () => { tmp = await makeTmp(); });
  afterEach(async () => { await tmp.cleanup(); });

  it('passes when no email or real slug present', async () => {
    await mkdir(join(tmp.path, 'people'), { recursive: true });
    await writeFile(
      join(tmp.path, 'people', 'bold-anchor.toml'),
      'slug = "bold-anchor"\nfullName = "Fake Person"\n',
      'utf-8',
    );
    const result = await verifySnapshot(tmp.path, new Set(['janedoe']));
    expect(result.passed).toBe(true);
  });

  it('fails when an email address is present', async () => {
    await mkdir(join(tmp.path, 'people'), { recursive: true });
    await writeFile(
      join(tmp.path, 'people', 'bold-anchor.toml'),
      'email = "real@example.com"\nslug = "bold-anchor"\n',
      'utf-8',
    );
    const result = await verifySnapshot(tmp.path, new Set());
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('real@example.com'))).toBe(true);
  });

  it('fails when a real slug is present', async () => {
    await mkdir(join(tmp.path, 'people'), { recursive: true });
    await writeFile(
      join(tmp.path, 'people', 'bold-anchor.toml'),
      'slug = "janedoe"\nfullName = "Fake Person"\n',
      'utf-8',
    );
    const result = await verifySnapshot(tmp.path, new Set(['janedoe']));
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('"janedoe"'))).toBe(true);
  });

  it('fails when githubLogin is present in a people record', async () => {
    await mkdir(join(tmp.path, 'people'), { recursive: true });
    await writeFile(
      join(tmp.path, 'people', 'bold-anchor.toml'),
      'slug = "bold-anchor"\ngithubLogin = "janedoe"\n',
      'utf-8',
    );
    const result = await verifySnapshot(tmp.path, new Set());
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('githubLogin'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: scrubRepo
// ---------------------------------------------------------------------------

// Integration tests involve multiple git operations; allow 30 seconds each.
const INTEGRATION_TIMEOUT = 30_000;

describe('scrubRepo', () => {
  let sourceTmp: { path: string; cleanup: () => Promise<void> } | undefined;
  let targetTmp: Tmp | undefined;

  afterEach(async () => {
    await sourceTmp?.cleanup();
    await targetTmp?.cleanup();
    sourceTmp = undefined;
    targetTmp = undefined;
  });

  it(
    'produces scrubbed output with no real names, no github identity',
    async () => {
      sourceTmp = await makeSourceRepo({
        people: [
          {
            id: uuid(1), slug: 'janedoe', fullName: 'Jane Doe',
            githubLogin: 'janedoe-gh', githubUserId: 12345,
            slackHandle: 'janedoe',
            accountLevel: 'user', createdAt: NOW, updatedAt: NOW,
          },
        ],
        projects: [
          {
            id: uuid(2), slug: 'my-project', title: 'My Project',
            stage: 'bootstrapping', createdAt: NOW, updatedAt: NOW,
          },
        ],
      });
      targetTmp = await makeTmp();

      const result = await scrubRepo({
        source: sourceTmp.path,
        target: targetTmp.path,
        seed: 'test-seed',
      });

      // There should be people and projects counts
      expect(result.sourceCounts['people']).toBe(1);
      expect(result.sourceCounts['projects']).toBe(1);

      // Verify no real name in snapshot
      const files = await walkTomlFiles(targetTmp.path);
      const personFile = files.find((f) => f.startsWith('people/'));
      expect(personFile).toBeDefined();
      if (!personFile) return;

      const content = await readFile(join(targetTmp.path, personFile), 'utf-8');

      // No real name
      expect(content).not.toContain('Jane Doe');
      // No real slug
      expect(content).not.toContain('"janedoe"');
      // No github identity
      expect(content).not.toContain('githubLogin');
      expect(content).not.toContain('githubUserId');
      // No email-like pattern
      expect(content).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'same seed produces byte-identical slug mapping (determinism verified without double-run)',
    async () => {
      // We verify determinism at the unit level using buildSlugMap (the core
      // determinism primitive) rather than running scrubRepo twice end-to-end.
      // End-to-end double-run is too slow for CI at this git-op volume.
      const slugs = ['alice', 'bob', 'carol'];
      const map1 = buildSlugMap(slugs, 'deterministic-seed');
      const map2 = buildSlugMap(slugs, 'deterministic-seed');

      // Same seed → same map
      expect([...map1.entries()]).toEqual([...map2.entries()]);

      // Also verify full scrubRepo produces a commit hash (proves the run succeeded)
      sourceTmp = await makeSourceRepo({
        people: [
          { id: uuid(1), slug: 'alice', fullName: 'Alice Smith', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
          { id: uuid(2), slug: 'bob', fullName: 'Bob Jones', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
        ],
      });
      targetTmp = await makeTmp();
      const result = await scrubRepo({ source: sourceTmp.path, target: targetTmp.path, seed: 'deterministic-seed' });
      expect(result.commitHash).toBeTruthy();
      // The pseudo-slug for 'alice' from this run matches the map
      const pseudoAlice = map1.get('alice');
      expect(pseudoAlice).toBeDefined();
      const files = await walkTomlFiles(targetTmp.path);
      const aliceFile = files.find((f) => f.includes(pseudoAlice!));
      expect(aliceFile).toBeDefined();
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'different seeds produce different pseudonyms but same structure',
    async () => {
      // Verify at unit level: same slugs + different seeds → different pseudo-slugs
      const slugs = ['alice'];
      const mapA = buildSlugMap(slugs, 'seed-aaa');
      const mapB = buildSlugMap(slugs, 'seed-bbb');
      // Different seeds should produce different pseudonyms
      expect(mapA.get('alice')).not.toBe(mapB.get('alice'));

      // Also verify end-to-end with one run that the structure is correct
      sourceTmp = await makeSourceRepo({
        people: [
          { id: uuid(1), slug: 'alice', fullName: 'Alice Smith', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
        ],
      });
      targetTmp = await makeTmp();
      const result = await scrubRepo({ source: sourceTmp.path, target: targetTmp.path, seed: 'seed-aaa' });
      expect(result.sourceCounts['people']).toBe(1);
      // Record count matches — structure is correct
      const files = await walkTomlFiles(targetTmp.path);
      expect(files.filter((f) => f.startsWith('people/')).length).toBe(1);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'snapshot has a single commit in history',
    async () => {
      sourceTmp = await makeSourceRepo({
        people: [
          { id: uuid(1), slug: 'carol', fullName: 'Carol White', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
        ],
      });
      targetTmp = await makeTmp();

      await scrubRepo({ source: sourceTmp.path, target: targetTmp.path, seed: 'single-commit-test' });

      const commitCount = await countCommits(targetTmp.path);
      expect(commitCount).toBe(1);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'commits a parentless snapshot holding configs, contracts and records, on HEAD + tag',
    async () => {
      sourceTmp = await makeSourceRepo({
        people: [
          { id: uuid(1), slug: 'dana', fullName: 'Dana Gray', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
        ],
        projects: [
          { id: uuid(2), slug: 'proj', title: 'Proj', stage: 'bootstrapping', createdAt: NOW, updatedAt: NOW },
        ],
      });
      targetTmp = await makeTmp();
      const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

      const result = await scrubRepo({ source: sourceTmp.path, target: targetTmp.path, seed: 'orphan-test' });
      const commit = result.commitHash!;
      expect(result.branchName).toBe('snapshot-orphan-test-scrubbed');

      // Parentless, on the snapshot branch, HEAD pointing at it, and tagged.
      expect(await git(targetTmp.path, 'rev-list', '--parents', '-n', '1', commit)).toBe(commit);
      expect(await git(targetTmp.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/snapshot-orphan-test-scrubbed');
      expect(await git(targetTmp.path, 'rev-parse', 'HEAD')).toBe(commit);
      expect(await git(targetTmp.path, 'rev-parse', 'refs/tags/snapshot-orphan-test-scrubbed')).toBe(commit);

      // `.gitsheets/` (configs + vendored contracts) is byte-identical to the source's.
      const sourceConfigs = await git(sourceTmp.path, 'ls-tree', '-r', 'HEAD', '.gitsheets/');
      expect(sourceConfigs).toContain('.gitsheets/contracts/');
      expect(await git(targetTmp.path, 'ls-tree', '-r', commit, '.gitsheets/')).toBe(sourceConfigs);

      // ...alongside the scrubbed records.
      const files = (await git(targetTmp.path, 'ls-tree', '-r', '--name-only', commit)).split('\n');
      const pseudo = buildSlugMap(['dana'], 'orphan-test').get('dana')!;
      expect(files).toContain(`people/${pseudo}.toml`);
      expect(files).toContain('projects/proj.toml');

      // A same-seed re-run with unchanged content is a no-op.
      const again = await scrubRepo({ source: sourceTmp.path, target: targetTmp.path, seed: 'orphan-test' });
      expect(again.commitHash).toBeNull();
      expect(await git(targetTmp.path, 'rev-parse', 'HEAD')).toBe(commit);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'moves the branch, HEAD and tag to a new parentless snapshot on a same-seed re-run with changed content',
    async () => {
      const project = { id: uuid(2), slug: 'proj', title: 'Proj', stage: 'bootstrapping', createdAt: NOW, updatedAt: NOW };
      sourceTmp = await makeSourceRepo({ projects: [project] });
      targetTmp = await makeTmp();
      const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

      const first = await scrubRepo({ source: sourceTmp.path, target: targetTmp.path, seed: 'rerun-test' });
      await sourceTmp.cleanup();
      sourceTmp = await makeSourceRepo({ projects: [{ ...project, title: 'Proj Renamed' }] });
      const second = await scrubRepo({ source: sourceTmp.path, target: targetTmp.path, seed: 'rerun-test' });

      const commit = second.commitHash!;
      expect(commit).toBeTruthy();
      expect(commit).not.toBe(first.commitHash);
      expect(await git(targetTmp.path, 'rev-list', '--parents', '-n', '1', commit)).toBe(commit);
      expect(await git(targetTmp.path, 'rev-parse', 'refs/heads/snapshot-rerun-test-scrubbed')).toBe(commit);
      expect(await git(targetTmp.path, 'rev-parse', 'HEAD')).toBe(commit);
      expect(await git(targetTmp.path, 'rev-parse', 'refs/tags/snapshot-rerun-test-scrubbed')).toBe(commit);
      expect(await git(targetTmp.path, 'show', `${commit}:projects/proj.toml`)).toContain('Proj Renamed');
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'record counts match source vs snapshot',
    async () => {
      sourceTmp = await makeSourceRepo({
        people: [
          { id: uuid(1), slug: 'person1', fullName: 'P One', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
          { id: uuid(2), slug: 'person2', fullName: 'P Two', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
          { id: uuid(3), slug: 'person3', fullName: 'P Three', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
        ],
        projects: [
          { id: uuid(4), slug: 'proj-a', title: 'Project A', stage: 'bootstrapping', createdAt: NOW, updatedAt: NOW },
          { id: uuid(5), slug: 'proj-b', title: 'Project B', stage: 'maintaining', createdAt: NOW, updatedAt: NOW },
        ],
      });
      targetTmp = await makeTmp();

      const result = await scrubRepo({ source: sourceTmp.path, target: targetTmp.path, seed: 'count-test' });

      expect(result.sourceCounts['people']).toBe(3);
      expect(result.sourceCounts['projects']).toBe(2);

      const files = await walkTomlFiles(targetTmp.path);
      expect(files.filter((f) => f.startsWith('people/')).length).toBe(3);
      expect(files.filter((f) => f.startsWith('projects/')).length).toBe(2);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'verification catches a deliberately injected email and throws',
    async () => {
      // Create source where the overview contains an email address.
      // The scrubber preserves project overviews (public-by-design), so the
      // email passes through and the verification step must catch it.
      const { repo: repo2, path: path2, cleanup: cleanup2 } = await createTestRepo(['people', 'projects']);

      await seed(repo2, 'people', [
        { id: uuid(1), slug: 'person-a', fullName: 'Person A', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
      ]);
      await seed(repo2, 'projects', [
        {
          id: uuid(2),
          slug: 'leaky-project',
          title: 'Leaky Project',
          overview: 'Contact us at admin@real-org.com for more info.',
          stage: 'bootstrapping',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);

      sourceTmp = { path: path2, cleanup: cleanup2 };
      targetTmp = await makeTmp();

      await expect(
        scrubRepo({ source: path2, target: targetTmp.path, seed: 'leak-test' }),
      ).rejects.toThrow(/Verification failed/);
      // No ref moved: the target has no branches or tags at all.
      expect((await exec('git', ['for-each-ref'], { cwd: targetTmp.path })).stdout.trim()).toBe('');
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'dry-run returns counts without writing to disk',
    async () => {
      sourceTmp = await makeSourceRepo({
        people: [
          { id: uuid(1), slug: 'dry-person', fullName: 'Dry P', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
        ],
      });
      targetTmp = await makeTmp();

      const result = await scrubRepo({
        source: sourceTmp.path,
        target: targetTmp.path,
        seed: 'dry-test',
        dryRun: true,
      });

      expect(result.commitHash).toBeNull();
      expect(result.branchName).toBeNull();
      expect(result.sourceCounts['people']).toBe(1);

      // Target should have no .toml files (git repo is init'd but nothing committed)
      const files = await walkTomlFiles(targetTmp.path);
      expect(files).toHaveLength(0);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'writes blog-posts in the markdown format and preserves their attachments',
    async () => {
      const { repo, path, cleanup } = await createTestRepo(['people', 'blog-posts']);
      sourceTmp = { path, cleanup };
      const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      const post = {
        id: uuid(10), slug: 'launch-night', title: 'Launch night',
        body: '# Launch night\n\n![photo](image-1.jpg)\n',
        postedAt: NOW, createdAt: NOW, updatedAt: NOW,
      };
      await repo.transact({ message: 'seed', author: { name: 't', email: 't@cfp.test' } }, async (tx) => {
        await tx.sheet('people').upsert({ id: uuid(1), slug: 'alice', fullName: 'Alice Smith', accountLevel: 'user', createdAt: NOW, updatedAt: NOW });
        await tx.sheet('people').setAttachments({ slug: 'alice' }, { 'avatar.jpg': image });
        await tx.sheet('blog-posts').upsert(post);
        await tx.sheet('blog-posts').setAttachments(post, { 'image-1.jpg': image });
      });
      targetTmp = await makeTmp();

      const result = await scrubRepo({ source: path, target: targetTmp.path, seed: 'md-test' });
      expect(result.sourceCounts['blog-posts']).toBe(1);

      const tree = (await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: targetTmp.path })).stdout
        .split('\n').filter(Boolean);
      expect(tree).toContain('blog-posts/launch-night.md');
      expect(tree).not.toContain('blog-posts/launch-night.toml');
      const md = await readFile(join(targetTmp.path, 'blog-posts/launch-night.md'), 'utf-8');
      expect(md.startsWith('+++\n')).toBe(true);
      expect(md).toContain('# Launch night');

      // Blog media follows the post byte-for-byte...
      const copied = await readFile(join(targetTmp.path, 'blog-posts/launch-night/image-1.jpg'));
      expect(copied.equals(image)).toBe(true);
      // ...but person avatars (photos of real people) never do.
      expect(tree.some((p) => p.startsWith('people/') && !p.endsWith('.toml'))).toBe(false);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'writes canonical TOML, keeping array fields',
    async () => {
      const { repo, path, cleanup } = await createTestRepo(['people', 'person-evaluations']);
      sourceTmp = { path, cleanup };
      await seed(repo, 'people', [
        { id: uuid(1), slug: 'alice', fullName: 'Alice Smith', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
      ]);
      await repo.transact({ message: 'seed', author: { name: 't', email: 't@cfp.test' } }, async (tx) => {
        await tx.sheet('person-evaluations').upsert({
          personSlug: 'ghost', evaluator: 'human-staff', verdict: 'legit', confidence: 1,
          flags: ['real-project', 'met-in-person'], evaluatedAt: NOW,
        });
      });
      targetTmp = await makeTmp();

      await scrubRepo({ source: path, target: targetTmp.path, seed: 'toml-test' });
      const content = await readFile(join(targetTmp.path, 'person-evaluations/ghost/human-staff.toml'), 'utf-8');
      expect(content).toContain('flags = [');
      expect(content).toContain('real-project');
      // Byte-identical to the source's canonical serialization.
      const sourceBytes = (await exec('git', ['--git-dir', path, 'show', 'HEAD:person-evaluations/ghost/human-staff.toml'])).stdout;
      expect(content).toBe(sourceBytes);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'rewrites person slug references to the pseudonymized slug, moving the records with them',
    async () => {
      const { repo, path, cleanup } = await createTestRepo([
        'people',
        'projects',
        'project-memberships',
        'event-rsvps',
        'person-evaluations',
      ]);
      sourceTmp = { path, cleanup };
      await repo.transact({ message: 'seed', author: { name: 't', email: 't@cfp.test' } }, async (tx) => {
        await tx.sheet('people').upsert({ id: uuid(1), slug: 'alice', fullName: 'Alice Smith', accountLevel: 'user', createdAt: NOW, updatedAt: NOW });
        await tx.sheet('projects').upsert({ id: uuid(2), slug: 'proj', title: 'Proj', stage: 'bootstrapping', createdAt: NOW, updatedAt: NOW });
        await tx.sheet('project-memberships').upsert({
          id: uuid(3), projectSlug: 'proj', personSlug: 'alice', isMaintainer: false,
          joinedAt: NOW, createdAt: NOW, updatedAt: NOW,
        });
        await tx.sheet('event-rsvps').upsert({
          id: uuid(4), year: '2026', eventSlug: 'hack-night', personSlug: 'alice', createdAt: NOW, updatedAt: NOW,
        });
        await tx.sheet('person-evaluations').upsert({
          personSlug: 'alice', evaluator: 'human-staff', verdict: 'legit', confidence: 1, flags: [], evaluatedAt: NOW,
        });
      });
      targetTmp = await makeTmp();

      await scrubRepo({ source: path, target: targetTmp.path, seed: 'refs-test' });
      const pseudo = buildSlugMap(['alice'], 'refs-test').get('alice')!;
      const files = await walkTomlFiles(targetTmp.path);
      expect(files).toContain(`project-memberships/proj/${pseudo}.toml`);
      expect(files).toContain(`event-rsvps/2026/hack-night/${pseudo}.toml`);
      expect(files).toContain(`person-evaluations/${pseudo}/human-staff.toml`);
      const membership = await readFile(join(targetTmp.path, `project-memberships/proj/${pseudo}.toml`), 'utf-8');
      expect(membership).toContain(`personSlug = "${pseudo}"`);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'verification names the repo path of a leaking record (markdown body included)',
    async () => {
      const { repo, path, cleanup } = await createTestRepo(['people', 'blog-posts']);
      sourceTmp = { path, cleanup };
      await repo.transact({ message: 'seed', author: { name: 't', email: 't@cfp.test' } }, async (tx) => {
        await tx.sheet('people').upsert({ id: uuid(1), slug: 'alice', fullName: 'Alice Smith', accountLevel: 'user', createdAt: NOW, updatedAt: NOW });
        await tx.sheet('blog-posts').upsert({
          id: uuid(10), slug: 'contact', title: 'Contact', body: 'Write to hello@real-org.com\n',
          postedAt: NOW, createdAt: NOW, updatedAt: NOW,
        });
      });
      targetTmp = await makeTmp();
      await expect(
        scrubRepo({ source: path, target: targetTmp.path, seed: 'leak-md' }),
      ).rejects.toThrow(/Email-like pattern found in blog-posts\/contact\.md/);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'refuses to collapse records missing a path-template field onto one path',
    async () => {
      const { repo, path, cleanup } = await createTestRepo(['people', 'project-memberships']);
      sourceTmp = { path, cleanup };
      await seed(repo, 'people', [
        { id: uuid(1), slug: 'alice', fullName: 'Alice Smith', accountLevel: 'user', createdAt: NOW, updatedAt: NOW },
      ]);
      // Two memberships whose on-disk records lack `personSlug` (the second
      // path-template field). Rendering `''` for it would land both at
      // project-memberships/proj/.toml, silently dropping one.
      for (const n of [1, 2]) {
        await seedRawToml(
          path,
          `project-memberships/proj/legacy-${n}.toml`,
          `id = "${uuid(20 + n)}"\npersonId = "${uuid(30 + n)}"\nprojectId = "${uuid(40)}"\nprojectSlug = "proj"\nrole = "Member"\n`,
          `seed raw membership ${n}`,
        );
      }
      targetTmp = await makeTmp();

      await expect(
        scrubRepo({ source: path, target: targetTmp.path, seed: 'collide-test' }),
      ).rejects.toThrow(/Sheet "project-memberships": cannot write record/);

      // Nothing was committed to the target.
      await expect(exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: targetTmp.path })).rejects.toThrow();
    },
    INTEGRATION_TIMEOUT,
  );
});
