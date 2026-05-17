/**
 * Tests for apps/api/scripts/cutover-dry-run.ts
 *
 * Exercises the orchestration end-to-end against the laddr fixture mysqldump:
 *   - importer runs and produces records
 *   - per-table row counts match per-sheet imported counts
 *   - smoke checks fire only when a target URL is provided
 *
 * The smoke-check leg is exercised against a stub fetch by injecting it as
 * a global override — we don't spin up the API in this test (covered in
 * api-skeleton.test.ts and read-api.test.ts).
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countRowsByTable,
  deterministicSample,
  runDryRun,
  runSmokeChecks,
} from '../scripts/cutover-dry-run.js';

const exec = promisify(execFile);
const FIXTURE_SQL = resolve(__dirname, '../scripts/fixtures/laddr-fixture.sql');

const SHEET_CONFIGS: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'people', path: '${{ slug }}' },
  { name: 'projects', path: '${{ slug }}' },
  { name: 'project-memberships', path: '${{ projectSlug }}/${{ personSlug }}' },
  { name: 'project-updates', path: '${{ projectSlug }}/${{ number }}' },
  { name: 'project-buzz', path: '${{ projectSlug }}/${{ slug }}' },
  { name: 'help-wanted-roles', path: '${{ projectSlug }}/${{ id }}' },
  { name: 'help-wanted-interest', path: '${{ roleId }}/${{ personSlug }}' },
  { name: 'tags', path: '${{ namespace }}/${{ slug }}' },
  { name: 'tag-assignments', path: '${{ tagId }}/${{ taggableType }}/${{ taggableId }}' },
  { name: 'slug-history', path: '${{ entityType }}/${{ oldSlug }}' },
  { name: 'revocations', path: '${{ jti }}' },
];

async function makeRepo(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cfp-dryrun-'));
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

async function makePrivate(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cfp-dryrun-priv-'));
  return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('countRowsByTable', () => {
  it('counts rows across multiple statements per table', () => {
    const sql = [
      "INSERT INTO `People` (`ID`, `Username`) VALUES (1,'alice'),(2,'bob');",
      "INSERT INTO `People` (`ID`, `Username`) VALUES (3,'carol');",
      "INSERT INTO `Projects` (`ID`, `Title`) VALUES (1,'A'),(2,'B'),(3,'C');",
    ].join('\n');
    const counts = countRowsByTable(sql);
    expect(counts.get('People')).toBe(3);
    expect(counts.get('Projects')).toBe(3);
  });

  it('ignores parentheses inside quoted strings', () => {
    const sql = "INSERT INTO `People` (`ID`, `Note`) VALUES (1, 'hello (world)'), (2, 'fun()');";
    expect(countRowsByTable(sql).get('People')).toBe(2);
  });

  it('handles the laddr fixture', async () => {
    const sql = await readFile(FIXTURE_SQL, 'utf8');
    const counts = countRowsByTable(sql);
    // The fixture has 4 people, 2 projects, etc — match against the same
    // expectations as import-laddr.test.ts so they evolve together.
    expect(counts.get('people')).toBe(4);
    expect(counts.get('projects')).toBe(2);
  });
});

describe('deterministicSample', () => {
  it('returns all items when n >= length', () => {
    expect(deterministicSample(['a', 'b'], 5, 'seed')).toEqual(['a', 'b']);
  });

  it('is deterministic across runs with the same seed', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const first = deterministicSample(items, 3, 'seed-1');
    const second = deterministicSample(items, 3, 'seed-1');
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
  });

  it('produces different results for different seeds', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const a = deterministicSample(items, 3, 'seed-1').sort();
    const b = deterministicSample(items, 3, 'seed-99').sort();
    expect(a).not.toEqual(b);
  });
});

describe('runDryRun (no target)', () => {
  it('runs the importer and emits a count diff per sheet', async () => {
    const repo = await makeRepo();
    const priv = await makePrivate();
    try {
      const report = await runDryRun({
        sql: FIXTURE_SQL,
        dataRepo: repo.path,
        privateStore: priv.path,
        target: null,
        sampleSize: 10,
        now: '2026-05-16T00:00:00.000Z',
      });

      expect(report.target).toBeNull();
      expect(report.smokeChecks).toEqual([]);
      expect(report.importReport.entities['people']!.imported).toBeGreaterThan(0);

      const peopleDiff = report.countDiffs.find((d) => d.sheet === 'people');
      expect(peopleDiff?.sourceRows).toBe(4);
      expect(peopleDiff?.importedRecords).toBe(4);
      expect(peopleDiff?.matched).toBe(true);

      expect(report.stages.import).toBe(true);
      expect(report.stages.countDiff).toBe(true);
      expect(report.stages.smoke).toBe(true);
      expect(report.passed).toBe(true);
    } finally {
      await repo.cleanup();
      await priv.cleanup();
    }
  }, 120_000);
});

describe('runSmokeChecks (stub fetch)', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('hits each smoke-test endpoint and records timings', async () => {
    const results = await runSmokeChecks({
      url: 'http://stub.local',
      samplePeople: ['alice'],
      samplePeopleLegacyIds: [],
      sampleProjects: ['squadquest'],
      sampleProjectLegacyIds: [42],
      // legacy-id smoke checks
      // - sample people legacy: skipped (empty)
      // - sample project legacy: /projects?ID=42
    });
    // We expect: 1 person + 1 project + 1 project-legacy + saml + oauth + 2 health
    expect(results).toHaveLength(7);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.some((r) => r.name === 'saml-metadata')).toBe(true);
    expect(results.some((r) => r.name === 'health-ready')).toBe(true);
  });
});
