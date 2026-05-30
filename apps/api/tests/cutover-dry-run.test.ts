/**
 * Tests for apps/api/scripts/cutover-dry-run.ts
 *
 * Exercises the orchestration end-to-end against an in-memory JSON mock of
 * laddr's `?format=json` endpoints:
 *   - importer runs and produces records
 *   - per-list-endpoint server `total` matches per-sheet imported counts
 *   - smoke checks fire only when a target URL is provided
 *
 * The smoke-check leg is exercised against a stub fetch by injecting it as
 * a global override — we don't spin up the API in this test (covered in
 * api-skeleton.test.ts and read-api.test.ts).
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deterministicSample,
  runDryRun,
  runSmokeChecks,
} from '../scripts/cutover-dry-run.js';

const exec = promisify(execFile);

const SHEET_CONFIGS: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'people', path: '${{ slug }}' },
  { name: 'projects', path: '${{ slug }}' },
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

function envelope(rows: unknown[], total: number, limit: number, offset: number) {
  return {
    success: true,
    total,
    limit,
    offset: offset === 0 ? false : offset,
    data: rows,
  };
}

/**
 * In-memory mock of laddr's JSON endpoints. Returns a 2-person, 1-project
 * snapshot; the dry-run report should observe matching counts for each
 * endpoint's reported `total`.
 */
function makeMockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString());
    const key = `${url.pathname}?${url.searchParams.get('format')}`;
    switch (url.pathname) {
      case '/tags':
        return new Response(
          JSON.stringify(
            envelope(
              [{ ID: 1, Class: 'Tag', Handle: 'topic.transit', Title: 'Transit', Created: 1377126953 }],
              1,
              200,
              0,
            ),
          ),
          { status: 200 },
        );
      case '/people':
        return new Response(
          JSON.stringify(
            envelope(
              [
                {
                  ID: 10,
                  Class: 'Emergence\\People\\User',
                  Username: 'alice',
                  FirstName: 'Alice',
                  LastName: 'A',
                  AccountLevel: 'User',
                  Created: 1377126953,
                },
                {
                  ID: 20,
                  Class: 'Emergence\\People\\User',
                  Username: 'bob',
                  FirstName: 'Bob',
                  LastName: 'B',
                  AccountLevel: 'User',
                  Created: 1377126953,
                },
              ],
              2,
              200,
              0,
            ),
          ),
          { status: 200 },
        );
      case '/projects':
        return new Response(
          JSON.stringify(
            envelope(
              [
                {
                  ID: 100,
                  Class: 'Laddr\\Project',
                  Handle: 'transit-app',
                  Title: 'Transit App',
                  MaintainerID: 10,
                  Stage: 'Prototyping',
                  Created: 1377126953,
                  Modified: 1377126953,
                },
              ],
              1,
              200,
              0,
            ),
          ),
          { status: 200 },
        );
      case '/project-updates':
        return new Response(
          JSON.stringify(envelope([], 0, 200, 0)),
          { status: 200 },
        );
      case '/project-buzz':
        return new Response(
          JSON.stringify(envelope([], 0, 200, 0)),
          { status: 200 },
        );
      case '/blog':
        return new Response(
          JSON.stringify(envelope([], 0, 200, 0)),
          { status: 200 },
        );
      default:
        return new Response(`Not found: ${key}`, { status: 404 });
    }
  }) as typeof fetch;
}

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
    try {
      const report = await runDryRun({
        sourceHost: 'example.test',
        dataRepo: repo.path,
        target: null,
        sampleSize: 10,
        now: '2026-05-18T00:00:00.000Z',
        fetchImpl: makeMockFetch(),
      });

      expect(report.target).toBeNull();
      expect(report.smokeChecks).toEqual([]);
      expect(report.importReport.counts['people']!.imported).toBe(2);

      const peopleDiff = report.countDiffs.find((d) => d.sheet === 'people');
      expect(peopleDiff?.sourceTotal).toBe(2);
      expect(peopleDiff?.importedRecords).toBe(2);
      expect(peopleDiff?.matched).toBe(true);

      const projectsDiff = report.countDiffs.find((d) => d.sheet === 'projects');
      expect(projectsDiff?.sourceTotal).toBe(1);
      expect(projectsDiff?.importedRecords).toBe(1);

      expect(report.stages.import).toBe(true);
      expect(report.stages.countDiff).toBe(true);
      expect(report.stages.smoke).toBe(true);
      expect(report.passed).toBe(true);
    } finally {
      await repo.cleanup();
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
