/**
 * prune-spam.ts — Re-runnable spam-prune operator script.
 *
 * Reads machine spam verdicts from the private spam-detection repo and staff
 * `human-*` votes from the data repo's served branch, aggregates them per the
 * spec rule (a human vote is final), and removes spam people from the
 * `published` branch with cascaded deletes of their associated records.
 *
 * Spec: specs/behaviors/spam-exclusion.md
 *
 * Usage:
 *   npm run -w apps/api script:prune-spam -- \
 *     --data-repo=/path/to/codeforphilly-data.git \
 *     --evaluations-repo=/path/to/codeforphilly-spam-detection \
 *     [--evaluations-ref=HEAD] \
 *     [--human-votes-ref=published] \
 *     [--branch=published] \
 *     [--threshold=0.8] \
 *     [--dry-run] [--verbose]
 *
 *   --data-repo        Path to a local bare clone of the data repo.
 *                      Falls back to $CFP_DATA_REPO_PATH.
 *   --evaluations-repo Repo (bare or not) holding machine person-evaluations —
 *                      the private codeforphilly-spam-detection clone. Defaults
 *                      to --data-repo for single-repo setups.
 *   --evaluations-ref  Ref in --evaluations-repo to read (default: HEAD).
 *   --human-votes-ref  Ref in --data-repo carrying staff votes (default: --branch).
 *   --branch           Branch to prune (default: published).
 *   --threshold        Spam confidence threshold (default: 0.8).
 *   --dry-run          Report without writing.
 *   --verbose          Increase logging verbosity.
 *
 * All reads and the prune commit go through gitsheets: evaluations are read
 * at their refs through read-only transactions, and the prune commits onto
 * `refs/heads/<branch>` via `transact({ parent, branch })`. The data repo's
 * HEAD is never moved.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { ConfigError, openRepo, type Repository } from 'gitsheets';

import { openPublicStore } from '../src/store/public.js';
import { SHEET_REFERENCES } from '@cfp/shared';
import { HUMAN_EVALUATOR_PREFIX } from '@cfp/shared/schemas';
import type { ProjectUpdate, TagAssignment } from '@cfp/shared/schemas';

/**
 * Records deleted with a pruned person: everything that references people by
 * slug (specs/data-model.md → References), except the person-evaluations —
 * the verdicts are the record of why the person was pruned and stay.
 */
const PRUNE_CASCADE = SHEET_REFERENCES.filter(
  (r) => r.target.sheet === 'people' && r.target.field === 'slug' && r.sheet !== 'person-evaluations',
);

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface CliArgs {
  readonly dataRepo: string;
  /** Repo holding the machine evaluations (the private spam-detection clone). Defaults to dataRepo. */
  readonly evaluationsRepo: string;
  readonly evaluationsRef: string;
  /** Ref in dataRepo carrying staff `human-*` votes. Defaults to --branch. */
  readonly humanVotesRef: string;
  readonly branch: string;
  readonly threshold: number;
  readonly dryRun: boolean;
  readonly verbose: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const opts: Record<string, string | true> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) opts[a.slice(2)] = true;
    else opts[a.slice(2, eq)] = a.slice(eq + 1);
  }

  const envRepo = process.env['CFP_DATA_REPO_PATH'];
  const dataRepoRaw =
    typeof opts['data-repo'] === 'string' && opts['data-repo'] !== ''
      ? opts['data-repo']
      : envRepo;
  if (!dataRepoRaw) {
    process.stderr.write('missing --data-repo=<path> (or set CFP_DATA_REPO_PATH)\n');
    process.exit(2);
  }

  const thresholdRaw = opts['threshold'];
  const threshold =
    typeof thresholdRaw === 'string' ? Number.parseFloat(thresholdRaw) : 0.8;

  const branch =
    typeof opts['branch'] === 'string' && opts['branch'] !== '' ? opts['branch'] : 'published';
  return {
    dataRepo: resolve(dataRepoRaw),
    evaluationsRepo:
      typeof opts['evaluations-repo'] === 'string' && opts['evaluations-repo'] !== ''
        ? resolve(opts['evaluations-repo'])
        : resolve(dataRepoRaw),
    evaluationsRef:
      typeof opts['evaluations-ref'] === 'string' && opts['evaluations-ref'] !== ''
        ? opts['evaluations-ref']
        : 'HEAD',
    humanVotesRef:
      typeof opts['human-votes-ref'] === 'string' && opts['human-votes-ref'] !== ''
        ? opts['human-votes-ref']
        : branch,
    branch,
    threshold: Number.isFinite(threshold) ? threshold : 0.8,
    dryRun: opts['dry-run'] === true,
    verbose: opts['verbose'] === true,
  };
}

// ---------------------------------------------------------------------------
// Verdict aggregation
// ---------------------------------------------------------------------------

export interface PersonVerdict {
  /** Whether any machine evaluator gave spam confidence >= threshold. */
  hasConfidentSpam: boolean;
  /** Whether any machine evaluator gave a legit verdict at any confidence. */
  hasAnyLegit: boolean;
  /**
   * The latest `human-*` verdict, if any. A human vote is final: `spam`
   * prunes regardless of machine verdicts or project membership; `legit`
   * keeps. Per specs/behaviors/spam-exclusion.md.
   */
  humanVerdict: string | null;
  humanEvaluatedAt: string | null;
}

/** Author stamped on the read-only transactions; they never commit. */
const READ_AUTHOR = { name: 'prune-spam (read-only)', email: 'api@users.noreply.codeforphilly.org' };

/**
 * Open a gitsheets Repository on a bare or non-bare clone. The evaluations
 * repo (the private spam-detection clone) is usually a working-tree clone.
 */
async function openAnyRepo(path: string): Promise<Repository> {
  const dotGit = join(path, '.git');
  return openRepo({ gitDir: existsSync(dotGit) ? dotGit : path });
}

/**
 * Fold one person-evaluation record into the per-person verdict map. A
 * record missing `verdict` (or, for machine records, `confidence`) does not
 * contribute — heuristic records carry `score`, never `confidence`.
 */
export function foldEvaluation(
  verdictMap: Map<string, PersonVerdict>,
  record: Readonly<Record<string, unknown>>,
  threshold: number,
): void {
  const personSlug = record['personSlug'];
  const evaluator = record['evaluator'];
  if (typeof personSlug !== 'string' || personSlug === '' || typeof evaluator !== 'string') return;

  const verdict = typeof record['verdict'] === 'string' && record['verdict'] !== '' ? record['verdict'] : null;
  const confidence =
    typeof record['confidence'] === 'number' && Number.isFinite(record['confidence'])
      ? record['confidence']
      : null;
  const rawAt = record['evaluatedAt'];
  const evaluatedAt =
    typeof rawAt === 'string' ? rawAt : rawAt instanceof Date ? rawAt.toISOString() : null;

  let entry = verdictMap.get(personSlug);
  if (!entry) {
    entry = { hasConfidentSpam: false, hasAnyLegit: false, humanVerdict: null, humanEvaluatedAt: null };
    verdictMap.set(personSlug, entry);
  }
  if (evaluator.startsWith(HUMAN_EVALUATOR_PREFIX)) {
    // Latest human vote wins; ties resolve to whichever is read last.
    if (verdict !== null && (entry.humanEvaluatedAt === null || (evaluatedAt ?? '') >= entry.humanEvaluatedAt)) {
      entry.humanVerdict = verdict;
      entry.humanEvaluatedAt = evaluatedAt ?? '';
    }
  } else if (verdict !== null && confidence !== null) {
    // Heuristic records carry `score`, not `confidence`, and never
    // reach here — they must be LLM-confirmed before they can prune.
    if (verdict === 'spam' && confidence >= threshold) entry.hasConfidentSpam = true;
    if (verdict === 'legit') entry.hasAnyLegit = true;
  }
}

/**
 * Read every person-evaluation at `ref` in `repo` and fold it into
 * `verdictMap`.
 *
 * gitsheets 2.7 has no public "sheet at a ref" handle, so this opens a
 * transaction parented on `ref` and only reads from it: a transaction with
 * no mutations finalizes to `commitHash: null` and moves no ref. Swap for
 * ref-scoped read-only sheets once gitsheets ships them (see the plan's
 * `awaits`). A ref without a person-evaluations sheet config contributes
 * nothing.
 */
export async function aggregateVerdicts(
  repoPath: string,
  ref: string,
  threshold: number,
  log: (msg: string) => void,
  verdictMap: Map<string, PersonVerdict> = new Map(),
): Promise<Map<string, PersonVerdict>> {
  log(`[prune-spam] reading person-evaluations in ${repoPath} at ref=${ref}`);
  const repo = await openAnyRepo(repoPath);
  // Parent on the resolved commit hash: the core takes branch names or
  // hashes (not `HEAD`), and a hash parent never updates any ref.
  const commit = await repo.resolveRef(ref);
  if (commit === null) throw new Error(`[prune-spam] ref '${ref}' not found in ${repoPath}`);
  const { value: records } = await repo.transact(
    { parent: commit, message: 'prune-spam: read person-evaluations (never committed)', author: READ_AUTHOR },
    async (tx) => {
      try {
        return await tx.sheet('person-evaluations').queryAll();
      } catch (err) {
        if (err instanceof ConfigError && err.code === 'config_missing') return [];
        throw err;
      }
    },
  );
  log(`[prune-spam] found ${records.length} evaluation records`);
  for (const record of records) foldEvaluation(verdictMap, record, threshold);
  return verdictMap;
}

/**
 * Compute the set of person slugs to prune. A human vote is final: `spam`
 * prunes, `legit` keeps. Otherwise prune iff hasConfidentSpam AND NOT
 * hasAnyLegit. Returns the human-spam subset too, since those bypass the
 * project-membership protection.
 */
function computePruneSet(verdictMap: Map<string, PersonVerdict>): {
  pruneSet: Set<string>;
  humanSpam: Set<string>;
} {
  const pruneSet = new Set<string>();
  const humanSpam = new Set<string>();
  for (const [slug, v] of verdictMap) {
    if (v.humanVerdict !== null) {
      if (v.humanVerdict === 'spam') {
        pruneSet.add(slug);
        humanSpam.add(slug);
      }
      continue;
    }
    if (v.hasConfidentSpam && !v.hasAnyLegit) {
      pruneSet.add(slug);
    }
  }
  return { pruneSet, humanSpam };
}

/** Minimal read surface shared by the live store and an open transaction. */
interface Queryable {
  people: { query(): AsyncIterable<unknown> };
  'project-memberships': { query(): AsyncIterable<unknown> };
}

interface CandidatePerson {
  readonly record: unknown;
  readonly id: string;
  readonly slug: string;
}

/**
 * Partition verdict-based candidates into those to prune vs. those protected
 * by an existing project membership. Real project involvement overrides a spam
 * verdict (see specs/behaviors/spam-exclusion.md). Scans people once and
 * project-memberships once against the given queryable.
 */
async function partitionCandidates(
  q: Queryable,
  candidateSlugs: Set<string>,
  humanSpam: Set<string> = new Set(),
): Promise<{ prune: CandidatePerson[]; protectedByMembership: number }> {
  const candidates: CandidatePerson[] = [];
  for await (const person of q.people.query()) {
    const p = person as Record<string, unknown>;
    const slug = p['slug'];
    const id = p['id'];
    if (typeof slug === 'string' && typeof id === 'string' && candidateSlugs.has(slug)) {
      candidates.push({ record: person, id, slug });
    }
  }

  const memberSlugs = new Set<string>();
  for await (const mem of q['project-memberships'].query()) {
    const slug = (mem as Record<string, unknown>)['personSlug'];
    if (typeof slug === 'string') memberSlugs.add(slug);
  }

  // Membership protects against machine verdicts only — a human looked at the
  // profile, so a human `spam` vote is not overridden by real-looking content.
  const prune = candidates.filter((c) => humanSpam.has(c.slug) || !memberSlugs.has(c.slug));
  return { prune, protectedByMembership: candidates.length - prune.length };
}

// ---------------------------------------------------------------------------
// Prune summary
// ---------------------------------------------------------------------------

export interface PruneSummary {
  readonly peopleBefore: number;
  readonly prunedPeople: number;
  readonly peopleAfter: number;
  readonly protectedByMembership: number;
  readonly membershipsDeleted: number;
  readonly helpWantedInterestDeleted: number;
  readonly eventRsvpsDeleted: number;
  readonly personTagAssignmentsDeleted: number;
  readonly projectUpdatesAuthorNulled: number;
  readonly commitHash: string | null;
  readonly noChanges: boolean;
}

// ---------------------------------------------------------------------------
// Branch resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the local branch the prune commits onto, creating it from
 * `origin/<branch>` when a fresh clone lacks it. HEAD is not touched — the
 * commit is aimed at the branch through `transact({ parent, branch })`.
 *
 * Creating the ref stays on raw git: gitsheets 2.7's `transact({ branch })`
 * only advances an existing branch (compare-and-swap against `parent`), and
 * exposes no public "create branch" call.
 */
async function resolveTargetBranch(repo: Repository, repoPath: string, branch: string): Promise<string> {
  const ref = `refs/heads/${branch}`;
  if ((await repo.resolveRef(ref)) !== null) return ref;
  const origin = await repo.resolveRef(`refs/remotes/origin/${branch}`);
  if (origin === null) throw new Error(`[prune-spam] branch '${branch}' not found in ${repoPath}`);
  // Create-only (empty old value): fails rather than clobbering a racing writer.
  await exec('git', ['update-ref', ref, origin, ''], { cwd: repoPath });
  return ref;
}

// ---------------------------------------------------------------------------
// Core prune logic
// ---------------------------------------------------------------------------

const AUTHOR_NAME = 'Code for Philly API';
const AUTHOR_EMAIL = 'api@users.noreply.codeforphilly.org';

export async function pruneSpam(args: CliArgs): Promise<PruneSummary> {
  const log = args.verbose
    ? (msg: string) => console.log(msg)
    : (): void => {};

  // -------------------------------------------------------------------------
  // 1. Read verdicts: machine evaluations + staff human votes
  // -------------------------------------------------------------------------
  log(
    `[prune-spam] reading machine verdicts from ${args.evaluationsRepo}@${args.evaluationsRef}, ` +
      `human votes from ${args.dataRepo}@${args.humanVotesRef}, threshold=${args.threshold}`,
  );
  const verdictMap = await aggregateVerdicts(
    args.evaluationsRepo,
    args.evaluationsRef,
    args.threshold,
    log,
  );
  await aggregateVerdicts(args.dataRepo, args.humanVotesRef, args.threshold, log, verdictMap);

  const { pruneSet, humanSpam } = computePruneSet(verdictMap);
  log(
    `[prune-spam] evaluated=${verdictMap.size} persons, pruneSet=${pruneSet.size} ` +
      `(${humanSpam.size} by human vote; the rest confident machine spam with no legit)`,
  );

  // -------------------------------------------------------------------------
  // 2. Open the data store and resolve the target branch
  // -------------------------------------------------------------------------
  const { store, repo } = await openPublicStore(args.dataRepo);
  const branchRef = await resolveTargetBranch(repo, args.dataRepo, args.branch);
  log(`[prune-spam] pruning ${args.dataRepo} ${branchRef}`);

  // -------------------------------------------------------------------------
  // 3. One atomic transaction on the branch: count, partition, then (unless
  //    dry-run) delete people + cascade. A dry-run mutates nothing, so the
  //    transaction finalizes without a commit.
  // -------------------------------------------------------------------------
  const runAt = new Date().toISOString();

  let peopleBefore = 0;
  let prunedPeople = 0;
  let protectedByMembership = 0;
  const referencesDeleted = new Map<string, number>();
  let personTagAssignmentsDeleted = 0;
  let projectUpdatesAuthorNulled = 0;

  const result = await store.transact(
    {
      parent: branchRef,
      branch: branchRef,
      message: `prune: remove confident-spam people from published (${runAt})\n\nThreshold: ${args.threshold}, pruneSet: ${pruneSet.size} slugs evaluated.\n`,
      author: { name: AUTHOR_NAME, email: AUTHOR_EMAIL },
      trailers: {
        Action: 'prune.spam',
        'Evaluations-Ref': args.evaluationsRef,
        'Threshold': String(args.threshold),
        'Run-At': runAt,
      },
    },
    async (tx) => {
      peopleBefore = await tx.people.count();
      log(`[prune-spam] peopleBefore=${peopleBefore}`);

      // --- Step A: Partition verdict candidates; protect project members ---
      // Real project involvement overrides a spam verdict, so candidates who
      // hold a project-membership are kept (see the spec).
      log(`[prune-spam] partitioning candidates (protecting project members)`);
      const { prune, protectedByMembership: protectedCount } = await partitionCandidates(
        tx as unknown as Queryable,
        pruneSet,
        humanSpam,
      );
      protectedByMembership = protectedCount;

      if (args.dryRun) {
        prunedPeople = prune.length;
        console.log(
          `[prune-spam] dry-run: would prune ${prune.length} (of ${pruneSet.size} verdict-flagged slugs); ${protectedByMembership} protected by project membership`,
        );
        return;
      }

      const prunedIds = new Set<string>(prune.map((c) => c.id));
      const prunedSlugs = new Set<string>(prune.map((c) => c.slug));
      for (const c of prune) {
        await tx.people.delete(c.record as Parameters<typeof tx.people.delete>[0]);
        prunedPeople++;
        log(`[prune-spam]   deleted person: slug=${c.slug} id=${c.id}`);
      }
      log(`[prune-spam] prunedPeople=${prunedPeople} protectedByMembership=${protectedByMembership}`);

      if (prunedPeople === 0) {
        log(`[prune-spam] nothing to prune (all spam persons already absent or protected)`);
        return;
      }

      // --- Steps B–C: Cascade-delete every record that references a pruned
      // person by slug (memberships, help-wanted interest, RSVPs) — the set
      // comes from the references the schemas declare. Memberships are
      // normally 0 (members are protected from machine verdicts); the sweep
      // still runs for human-vote prunes and stale records.
      for (const ref of PRUNE_CASCADE) {
        log(`[prune-spam] scanning ${ref.sheet} for cascade deletes`);
        const sheet = tx[ref.sheet] as unknown as {
          query(): AsyncIterable<Record<string, unknown>>;
          delete(record: unknown): Promise<void>;
        };
        let deleted = 0;
        for await (const record of sheet.query()) {
          const value = record[ref.field];
          if (typeof value === 'string' && prunedSlugs.has(value)) {
            await sheet.delete(record);
            deleted++;
          }
        }
        referencesDeleted.set(ref.sheet, (referencesDeleted.get(ref.sheet) ?? 0) + deleted);
        log(`[prune-spam] ${ref.sheet} deleted=${deleted}`);
      }

      // --- Step D: Cascade-delete person tag-assignments (path: taggableType/taggableId/tagId) ---
      log(`[prune-spam] scanning tag-assignments for cascade deletes (person type only)`);
      for await (const ta of tx['tag-assignments'].query()) {
        const t = ta as unknown as TagAssignment;
        if (t.taggableType === 'person' && prunedIds.has(t.taggableId)) {
          await tx['tag-assignments'].delete(ta as unknown as TagAssignment);
          personTagAssignmentsDeleted++;
        }
      }
      log(`[prune-spam] personTagAssignmentsDeleted=${personTagAssignmentsDeleted}`);

      // --- Step E: Null authorId on project-updates authored by pruned people ---
      log(`[prune-spam] scanning project-updates for authorId nulling`);
      for await (const update of tx['project-updates'].query()) {
        const u = update as unknown as ProjectUpdate;
        if (u.authorId !== null && u.authorId !== undefined && prunedIds.has(u.authorId)) {
          // patch applies a JSON Merge Patch — sets authorId to null
          await tx['project-updates'].patch(
            { id: u.id } as Record<string, unknown>,
            { authorId: null } as Partial<ProjectUpdate>,
          );
          projectUpdatesAuthorNulled++;
        }
      }
      log(`[prune-spam] projectUpdatesAuthorNulled=${projectUpdatesAuthorNulled}`);
    },
  );

  const peopleAfter = peopleBefore - prunedPeople;
  if (args.dryRun && result.commitHash !== null) {
    throw new Error('[prune-spam] internal: dry-run produced a commit');
  }

  return {
    peopleBefore,
    prunedPeople,
    peopleAfter,
    protectedByMembership,
    membershipsDeleted: referencesDeleted.get('project-memberships') ?? 0,
    helpWantedInterestDeleted: referencesDeleted.get('help-wanted-interest') ?? 0,
    eventRsvpsDeleted: referencesDeleted.get('event-rsvps') ?? 0,
    personTagAssignmentsDeleted,
    projectUpdatesAuthorNulled,
    commitHash: result.commitHash,
    noChanges: result.commitHash === null,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[prune-spam] data-repo=${args.dataRepo}`);
  console.log(`[prune-spam] evaluations-ref=${args.evaluationsRef}`);
  console.log(`[prune-spam] branch=${args.branch}`);
  console.log(`[prune-spam] threshold=${args.threshold}`);
  console.log(`[prune-spam] dry-run=${args.dryRun} verbose=${args.verbose}`);

  const summary = await pruneSpam(args);
  printSummary(summary, args);
}

function printSummary(summary: PruneSummary, args: CliArgs): void {
  const lines: string[] = [];
  lines.push('\n=== prune-spam report ===');
  lines.push(`peopleBefore:                 ${summary.peopleBefore}`);
  lines.push(`prunedPeople:                 ${summary.prunedPeople}`);
  lines.push(`peopleAfter:                  ${summary.peopleAfter}`);
  lines.push(`protectedByMembership:        ${summary.protectedByMembership}`);
  lines.push(`membershipsDeleted:           ${summary.membershipsDeleted}`);
  lines.push(`helpWantedInterestDeleted:    ${summary.helpWantedInterestDeleted}`);
  lines.push(`eventRsvpsDeleted:            ${summary.eventRsvpsDeleted}`);
  lines.push(`personTagAssignmentsDeleted:  ${summary.personTagAssignmentsDeleted}`);
  lines.push(`projectUpdatesAuthorNulled:   ${summary.projectUpdatesAuthorNulled}`);
  if (args.dryRun) {
    lines.push(`(dry-run: no writes performed)`);
  } else if (summary.noChanges) {
    lines.push(`(no changes — branch unchanged, idempotent)`);
  } else if (summary.commitHash) {
    lines.push(`commit: ${summary.commitHash} on ${args.branch}`);
  }
  console.log(lines.join('\n'));
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  main().catch((err: unknown) => {
    console.error('[prune-spam] failed:', err);
    process.exit(1);
  });
}
