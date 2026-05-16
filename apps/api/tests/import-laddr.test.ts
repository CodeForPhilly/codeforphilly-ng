import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { FilesystemPrivateStore } from '../src/store/private/filesystem.js';
import { importLaddr } from '../scripts/import-laddr/importer.js';
import { parseInsertStatement } from '../scripts/import-laddr/mysqldump-parser.js';

const exec = promisify(execFile);
const FIXTURE = resolve(__dirname, '../scripts/fixtures/laddr-fixture.sql');

const SHEET_CONFIGS: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'people', path: '${{ slug }}' },
  { name: 'projects', path: '${{ slug }}' },
  { name: 'project-memberships', path: '${{ projectSlug }}/${{ personSlug }}' },
  { name: 'project-updates', path: '${{ projectSlug }}/${{ number }}' },
  { name: 'project-buzz', path: '${{ projectSlug }}/${{ slug }}' },
  { name: 'tags', path: '${{ namespace }}/${{ slug }}' },
  { name: 'tag-assignments', path: '${{ tagId }}/${{ taggableType }}/${{ taggableId }}' },
];

async function makeRepo(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cfp-import-'));
  const git = (...a: string[]) => exec('git', a, { cwd: dir });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@cfp.test');
  await git('config', 'user.name', 'test');
  await git('config', 'commit.gpgsign', 'false');
  await git('commit', '--allow-empty', '-m', 'initial');

  await mkdir(join(dir, '.gitsheets'), { recursive: true });
  for (const { name, path } of SHEET_CONFIGS) {
    const cfg = `[gitsheet]\nroot = '${name}'\npath = '${path}'\n`;
    await writeFile(join(dir, '.gitsheets', `${name}.toml`), cfg);
  }
  await git('add', '.gitsheets');
  await git('commit', '-m', 'configs');

  return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function makePrivate(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cfp-priv-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('mysqldump-parser', () => {
  it('parses a simple INSERT', () => {
    const rows = parseInsertStatement(
      "VALUES (1,'foo','bar'),(2,'baz',NULL);",
      ['id', 'a', 'b'],
    );
    expect(rows).toEqual([
      { id: 1, a: 'foo', b: 'bar' },
      { id: 2, a: 'baz', b: null },
    ]);
  });

  it('handles escaped quotes and backslashes', () => {
    const rows = parseInsertStatement(
      "VALUES (1,'it\\'s \"safe\"','line1\\nline2');",
      ['id', 'a', 'b'],
    );
    expect(rows[0]!['a']).toBe('it\'s "safe"');
    expect(rows[0]!['b']).toBe('line1\nline2');
  });

  it('handles \\N as NULL', () => {
    const rows = parseInsertStatement('VALUES (1,\\N);', ['id', 'a']);
    expect(rows[0]!['a']).toBeNull();
  });
});

describe('import-laddr against fixture', () => {
  it('produces expected counts in dry-run with no writes', async () => {
    const repo = await makeRepo();
    const priv = await makePrivate();
    try {
      const store = new FilesystemPrivateStore({
        CFP_PRIVATE_STORAGE_PATH: priv.dir,
      });
      await store.load();

      const report = await importLaddr({
        sql: FIXTURE,
        dataRepo: repo.path,
        privateStore: store,
        dryRun: true,
        now: '2026-05-15T00:00:00.000Z',
      });

      expect(report.entities['people']).toEqual({
        input: 4,
        imported: 4,
        skipped: 0,
        errors: 0,
      });
      expect(report.entities['projects']).toEqual({
        input: 2,
        imported: 2,
        skipped: 0,
        errors: 0,
      });
      expect(report.entities['tags']!.imported).toBe(3);
      expect(report.entities['project-memberships']!.imported).toBe(3);
      expect(report.entities['project-updates']!.imported).toBe(3);
      expect(report.entities['project-buzz']!.imported).toBe(1);
      expect(report.entities['tag-assignments']!.imported).toBe(3);

      expect(report.commits).toHaveLength(0);
      expect(existsSync(join(priv.dir, 'profiles.jsonl'))).toBe(false);

      // Slug normalization warning for "Weird Name!"
      expect(
        report.warnings.some((w) => w.includes('Weird Name') && w.includes('normalized')),
      ).toBe(true);
    } finally {
      await repo.cleanup();
      await priv.cleanup();
    }
  });

  it('writes records, commits per entity, and seeds private store', { timeout: 120_000 }, async () => {
    const repo = await makeRepo();
    const priv = await makePrivate();
    try {
      const store = new FilesystemPrivateStore({
        CFP_PRIVATE_STORAGE_PATH: priv.dir,
      });
      await store.load();

      const report = await importLaddr({
        sql: FIXTURE,
        dataRepo: repo.path,
        privateStore: store,
        now: '2026-05-15T00:00:00.000Z',
      });

      // 7 entity commits (one per sheet) on top of the 2 config/init commits
      expect(report.commits.length).toBeGreaterThan(0);

      // Records landed in the public repo (read via git tree, not working dir;
      // gitsheets updates refs only, no working-tree checkout)
      const tree = await exec(
        'git',
        ['ls-tree', '-r', '--name-only', 'HEAD'],
        { cwd: repo.path },
      );
      const treePaths = tree.stdout.split('\n').filter(Boolean);
      const peopleFiles = treePaths
        .filter((p) => p.startsWith('people/') && p.endsWith('.toml'))
        .map((p) => p.slice('people/'.length))
        .sort();
      expect(peopleFiles).toEqual([
        'bobsmith.toml',
        'jane-doe.toml',
        'no-email.toml',
        'weird-name.toml',
      ]);

      const janeToml = (
        await exec('git', ['show', 'HEAD:people/jane-doe.toml'], { cwd: repo.path })
      ).stdout;
      expect(janeToml).toContain('slug = "jane-doe"');
      expect(janeToml).toContain('legacyId = 1');
      expect(janeToml).toContain('slackSamlNameId = "jane-doe"');
      expect(janeToml).toContain('accountLevel = "administrator"');

      // PII must NOT be in the public repo — scan every committed TOML
      for (const path of treePaths.filter((p) => p.endsWith('.toml'))) {
        const content = (
          await exec('git', ['show', `HEAD:${path}`], { cwd: repo.path })
        ).stdout;
        expect(
          content,
          `expected no @example/example.com/.org in ${path}`,
        ).not.toMatch(/@example\./);
        expect(content, `expected no bcrypt $2y$ hash in ${path}`).not.toMatch(/\$2y\$/);
      }

      // Private store has all 3 emailed profiles + 2 legacy-password records
      const profilesJsonl = await readFile(join(priv.dir, 'profiles.jsonl'), 'utf8');
      const profileLines = profilesJsonl.trim().split('\n').filter(Boolean);
      expect(profileLines).toHaveLength(3);
      const profiles = profileLines.map((l) => JSON.parse(l));
      const emails = profiles.map((p) => p.email).sort();
      expect(emails).toEqual([
        'bob@example.org',
        'carol@example.net',
        'jane@example.com',
      ]);

      const legacyJsonl = await readFile(join(priv.dir, 'legacy-passwords.jsonl'), 'utf8');
      const legacyLines = legacyJsonl.trim().split('\n').filter(Boolean);
      expect(legacyLines).toHaveLength(2);

      // Tag namespace splitting
      const tagNamespaces = new Set(
        treePaths
          .filter((p) => p.startsWith('tags/') && p.endsWith('.toml'))
          .map((p) => p.split('/')[1]!),
      );
      expect([...tagNamespaces].sort()).toEqual(['event', 'tech', 'topic']);
      const flutterToml = (
        await exec('git', ['show', 'HEAD:tags/tech/flutter.toml'], {
          cwd: repo.path,
        })
      ).stdout;
      expect(flutterToml).toContain('namespace = "tech"');
      expect(flutterToml).toContain('slug = "flutter"');

      // Project stage lowercase
      const sqProject = (
        await exec('git', ['show', 'HEAD:projects/squadquest.toml'], {
          cwd: repo.path,
        })
      ).stdout;
      expect(sqProject).toContain('stage = "testing"');

      // Membership composite path
      expect(
        treePaths.includes('project-memberships/squadquest/jane-doe.toml'),
      ).toBe(true);

      // ProjectUpdate per-project numbering — squadquest gets 2 updates: 1, 2
      const sqUpdates = treePaths
        .filter((p) => p.startsWith('project-updates/squadquest/'))
        .map((p) => p.slice('project-updates/squadquest/'.length))
        .sort();
      expect(sqUpdates).toEqual(['1.toml', '2.toml']);

      // tag-assignments use commit trailer Action: import.laddr
      const log = await exec(
        'git',
        ['log', '--format=%B%n---END---'],
        { cwd: repo.path },
      );
      expect(log.stdout).toContain('Action: import.laddr');
      expect(log.stdout).toContain(`Source-Dump: ${report.sourceSha256}`);

      // Author is the pseudonymous Code for Philly API identity
      const authorLog = await exec('git', ['log', '--format=%an <%ae>'], {
        cwd: repo.path,
      });
      expect(authorLog.stdout).toContain(
        'Code for Philly API <api@users.noreply.codeforphilly.org>',
      );

      // Re-running yields no new files in the tree (idempotent — same
      // legacyIds produce the same slugs which dedupe at upsert time).
      const beforeTree = (
        await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
          cwd: repo.path,
        })
      ).stdout;
      await importLaddr({
        sql: FIXTURE,
        dataRepo: repo.path,
        privateStore: store,
        now: '2026-05-15T00:00:00.000Z',
      });
      const afterTree = (
        await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
          cwd: repo.path,
        })
      ).stdout;
      expect(afterTree).toBe(beforeTree);
    } finally {
      await repo.cleanup();
      await priv.cleanup();
    }
  });

  it('respects --limit', async () => {
    const repo = await makeRepo();
    const priv = await makePrivate();
    try {
      const store = new FilesystemPrivateStore({
        CFP_PRIVATE_STORAGE_PATH: priv.dir,
      });
      await store.load();

      const report = await importLaddr({
        sql: FIXTURE,
        dataRepo: repo.path,
        privateStore: store,
        dryRun: true,
        limit: 1,
        now: '2026-05-15T00:00:00.000Z',
      });

      expect(report.entities['people']!.input).toBe(4);
      expect(report.entities['people']!.imported).toBe(1);
      expect(report.entities['projects']!.imported).toBe(1);
      expect(report.entities['tags']!.imported).toBe(1);
    } finally {
      await repo.cleanup();
      await priv.cleanup();
    }
  });
});

