/**
 * Tests for apps/api/scripts/prune-spam.ts
 *
 * Covers the aggregation rule from specs/behaviors/spam-exclusion.md (human
 * vote is final, confident machine spam with no legit, membership
 * protection), the cascade, dry-run, records with multibyte `reasoning`
 * text, and a few-thousand-record run.
 */
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

import { openRepo } from 'gitsheets';
import { afterEach, describe, expect, it } from 'vitest';

import { pruneSpam, type CliArgs } from '../scripts/prune-spam.js';
import { createFullDataRepo, type FullTestRepo } from './helpers/test-full-repo.js';
import { createTestRepo, type AppTestRepo } from './helpers/test-repo.js';

const exec = promisify(execFile);

const NOW = '2026-05-16T00:00:00Z';
const LATER = '2026-06-01T00:00:00Z';
const AUTHOR = { name: 'test', email: 'test@cfp.test' };
const uuid = (n: number): string => `01951a3c-0000-7000-8000-${String(n).padStart(12, '0')}`;

const MULTIBYTE_REASONING =
  'Profil rempli de liens commerciaux — «achetez maintenant» ✓ 日本語のスパム 🚫 ' +
  'Ünïcödé everywhere: ñ, ø, ß, €, 中文, 한국어.';

interface Evaluation {
  personSlug: string;
  evaluator: string;
  verdict: 'spam' | 'legit' | 'uncertain';
  confidence?: number;
  score?: number;
  flags: string[];
  reasoning?: string;
  evaluatedAt: string;
}

function machine(personSlug: string, verdict: Evaluation['verdict'], confidence: number, reasoning = 'looks like spam'): Evaluation {
  return { personSlug, evaluator: 'haiku-2026-05', verdict, confidence, flags: ['test'], reasoning, evaluatedAt: NOW };
}

function person(n: number, slug: string): Record<string, unknown> {
  return { id: uuid(n), slug, fullName: `Person ${n}`, accountLevel: 'user', createdAt: NOW, updatedAt: NOW };
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
}

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

/**
 * A bare data repo with a `published` branch holding `people` + cascade
 * fixtures + human votes, and a separate evaluations repo holding machine
 * verdicts. HEAD stays on `main` in the data repo so the tests can tell
 * whether the script moves it.
 */
async function setup(opts: {
  people: Array<Record<string, unknown>>;
  machineEvals: Evaluation[];
  humanVotes?: Evaluation[];
  memberships?: Array<Record<string, unknown>>;
  extra?: (tx: Parameters<Parameters<Awaited<ReturnType<typeof openRepo>>['transact']>[1]>[0]) => Promise<void>;
  /** Make the evaluations repo a non-bare clone (as the private repo is). */
  nonBareEvaluations?: boolean;
}): Promise<{ data: FullTestRepo; evaluationsPath: string }> {
  const data = await createFullDataRepo();
  cleanups.push(data.cleanup);
  const dataRepo = await openRepo({ gitDir: data.path });
  await dataRepo.transact({ message: 'seed', author: AUTHOR }, async (tx) => {
    for (const p of opts.people) await tx.sheet('people').upsert(p);
    for (const m of opts.memberships ?? []) await tx.sheet('project-memberships').upsert(m);
    for (const v of opts.humanVotes ?? []) await tx.sheet('person-evaluations').upsert({ ...v });
    if (opts.extra) await opts.extra(tx);
  });
  await git(data.path, 'branch', 'published', 'main');

  const evals: AppTestRepo = await createTestRepo(['person-evaluations']);
  cleanups.push(evals.cleanup);
  await evals.repo.transact({ message: 'seed evals', author: AUTHOR }, async (tx) => {
    for (const e of opts.machineEvals) await tx.sheet('person-evaluations').upsert({ ...e });
  });

  let evaluationsPath = evals.path;
  if (opts.nonBareEvaluations) {
    evaluationsPath = `${evals.path}-wt`;
    await exec('git', ['clone', '--quiet', evals.path, evaluationsPath]);
    cleanups.push(() => rm(evaluationsPath, { recursive: true, force: true }));
  }
  return { data, evaluationsPath };
}

function args(data: FullTestRepo, evaluationsPath: string, over: Partial<CliArgs> = {}): CliArgs {
  return {
    dataRepo: data.path,
    evaluationsRepo: evaluationsPath,
    evaluationsRef: 'HEAD',
    humanVotesRef: 'published',
    branch: 'published',
    threshold: 0.8,
    dryRun: false,
    verbose: false,
    ...over,
  };
}

async function slugsOn(repoPath: string, ref: string, root: string): Promise<string[]> {
  const out = await git(repoPath, 'ls-tree', '-r', '--name-only', ref, `${root}/`);
  return out.split('\n').filter(Boolean).map((p) => p.slice(root.length + 1).replace(/\.toml$/, '')).sort();
}

describe('prune-spam', () => {
  it('applies the aggregation rule, cascades, and commits onto the branch', async () => {
    const roleId = uuid(900);
    const { data, evaluationsPath } = await setup({
      people: [
        person(1, 'spammer'),
        person(2, 'protected-by-legit'),
        person(3, 'member-spammer'),
        person(4, 'human-spam-member'),
        person(5, 'human-legit'),
        person(6, 'low-confidence'),
        person(7, 'clean'),
        person(8, 'human-flipflop'),
      ],
      machineEvals: [
        machine('spammer', 'spam', 0.95),
        machine('protected-by-legit', 'spam', 0.9),
        { ...machine('protected-by-legit', 'legit', 0.4), evaluator: 'sonnet-2026-05' },
        machine('member-spammer', 'spam', 0.99),
        machine('human-legit', 'spam', 0.99),
        machine('low-confidence', 'spam', 0.5),
        { personSlug: 'clean', evaluator: 'heuristic-v1', verdict: 'spam', score: 12, flags: [], evaluatedAt: NOW },
        machine('human-flipflop', 'legit', 0.9),
      ],
      humanVotes: [
        { personSlug: 'human-spam-member', evaluator: 'human-admin', verdict: 'spam', confidence: 1, flags: [], evaluatedAt: NOW },
        { personSlug: 'human-legit', evaluator: 'human-admin', verdict: 'legit', confidence: 1, flags: [], evaluatedAt: NOW },
        // Latest human vote wins: legit (earlier) then spam (later) → spam.
        { personSlug: 'human-flipflop', evaluator: 'human-a', verdict: 'legit', confidence: 1, flags: [], evaluatedAt: NOW },
        { personSlug: 'human-flipflop', evaluator: 'human-b', verdict: 'spam', confidence: 1, flags: [], evaluatedAt: LATER },
      ],
      memberships: [
        { id: uuid(101), projectId: uuid(200), personId: uuid(3), projectSlug: 'proj', personSlug: 'member-spammer', role: 'Member', isMaintainer: false, joinedAt: NOW, createdAt: NOW, updatedAt: NOW },
        { id: uuid(102), projectId: uuid(200), personId: uuid(4), projectSlug: 'proj', personSlug: 'human-spam-member', role: 'Member', isMaintainer: false, joinedAt: NOW, createdAt: NOW, updatedAt: NOW },
      ],
      extra: async (tx) => {
        await tx.sheet('tag-assignments').upsert({ id: uuid(301), tagId: uuid(400), taggableType: 'person', taggableId: uuid(1), createdAt: NOW });
        await tx.sheet('tag-assignments').upsert({ id: uuid(302), tagId: uuid(400), taggableType: 'person', taggableId: uuid(7), createdAt: NOW });
        await tx.sheet('help-wanted-interest').upsert({ id: uuid(501), roleId, personId: uuid(1), personSlug: 'spammer', createdAt: NOW });
        await tx.sheet('project-updates').upsert({ id: uuid(601), projectId: uuid(200), authorId: uuid(1), body: 'hi', number: 1, projectSlug: 'proj', createdAt: NOW, updatedAt: NOW });
      },
    });

    const headBefore = await git(data.path, 'symbolic-ref', 'HEAD');
    const mainBefore = await git(data.path, 'rev-parse', 'main');
    const summary = await pruneSpam(args(data, evaluationsPath));

    expect(summary).toMatchObject({
      peopleBefore: 8,
      prunedPeople: 3,
      peopleAfter: 5,
      protectedByMembership: 1,
      membershipsDeleted: 1,
      helpWantedInterestDeleted: 1,
      personTagAssignmentsDeleted: 1,
      projectUpdatesAuthorNulled: 1,
      noChanges: false,
    });
    expect(summary.commitHash).toBe(await git(data.path, 'rev-parse', 'published'));
    expect(await slugsOn(data.path, 'published', 'people')).toEqual(
      ['clean', 'human-legit', 'low-confidence', 'member-spammer', 'protected-by-legit'],
    );
    const update = await git(data.path, 'show', 'published:project-updates/proj/1.toml');
    expect(update).not.toContain('authorId');

    // The commit landed via gitsheets on the branch: HEAD and other refs untouched.
    expect(await git(data.path, 'symbolic-ref', 'HEAD')).toBe(headBefore);
    expect(await git(data.path, 'rev-parse', 'main')).toBe(mainBefore);
    const trailers = await git(data.path, 'log', '-1', '--format=%B', 'published');
    expect(trailers).toContain('Action: prune.spam');

    // Idempotent: a second run commits nothing.
    const again = await pruneSpam(args(data, evaluationsPath));
    expect(again.prunedPeople).toBe(0);
    expect(again.noChanges).toBe(true);
    expect(await git(data.path, 'rev-parse', 'published')).toBe(summary.commitHash);
  });

  it('dry-run reports the prune set without writing', async () => {
    const { data, evaluationsPath } = await setup({
      people: [person(1, 'spammer'), person(2, 'kept')],
      machineEvals: [machine('spammer', 'spam', 0.95), machine('kept', 'spam', 0.2)],
    });
    const before = await git(data.path, 'rev-parse', 'published');
    const summary = await pruneSpam(args(data, evaluationsPath, { dryRun: true }));
    expect(summary).toMatchObject({ peopleBefore: 2, prunedPeople: 1, peopleAfter: 1, commitHash: null });
    expect(await git(data.path, 'rev-parse', 'published')).toBe(before);
  });

  it('parses records with multibyte reasoning text', async () => {
    // Every record is confident spam with multibyte reasoning: a
    // byte-vs-char slicing bug desynchronizes the stream after the first
    // multibyte record and silently drops later ones, so fewer get pruned.
    const people: Array<Record<string, unknown>> = [];
    const evals: Evaluation[] = [];
    for (let i = 0; i < 40; i++) {
      const slug = `person-${String(i).padStart(3, '0')}`;
      people.push(person(i + 1, slug));
      evals.push(machine(slug, 'spam', 0.95, `${MULTIBYTE_REASONING} #${i}`));
    }
    const { data, evaluationsPath } = await setup({ people, machineEvals: evals, nonBareEvaluations: true });

    const summary = await pruneSpam(args(data, evaluationsPath));
    expect(summary.prunedPeople).toBe(40);
    expect(await slugsOn(data.path, 'published', 'people')).toEqual([]);
  });

  it('handles a few thousand evaluation records in one pass', async () => {
    const N = 3000;
    const people: Array<Record<string, unknown>> = [];
    const evals: Evaluation[] = [];
    for (let i = 0; i < N; i++) {
      const slug = `p${i}`;
      people.push(person(i + 1, slug));
      evals.push(machine(slug, i % 3 === 0 ? 'spam' : 'legit', 0.9));
    }
    const { data, evaluationsPath } = await setup({ people, machineEvals: evals });

    const started = Date.now();
    const summary = await pruneSpam(args(data, evaluationsPath, { dryRun: true }));
    expect(summary.prunedPeople).toBe(N / 3);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);
});
