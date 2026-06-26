/**
 * prune-spam.ts — Re-runnable spam-prune operator script.
 *
 * Reads spam verdicts from the `spam-detection` branch of the data repo,
 * aggregates them per the spec rule, and removes confident-spam people from
 * the `published` branch with cascaded deletes of their associated records.
 *
 * Spec: specs/behaviors/spam-exclusion.md
 *
 * Usage:
 *   npm run -w apps/api script:prune-spam -- \
 *     --data-repo=/path/to/codeforphilly-data \
 *     [--evaluations-ref=spam-detection] \
 *     [--branch=published] \
 *     [--threshold=0.8] \
 *     [--dry-run] [--verbose]
 *
 *   --data-repo        Path to a local bare clone of the data repo.
 *                      Falls back to $CFP_DATA_REPO_PATH.
 *   --evaluations-ref  Ref to read person-evaluations from (default: spam-detection).
 *   --branch           Branch to prune (default: published).
 *   --threshold        Spam confidence threshold (default: 0.8).
 *   --dry-run          Report without writing.
 *   --verbose          Increase logging verbosity.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

import { openPublicStore } from '../src/store/public.js';
import type {
  HelpWantedInterestExpression,
  ProjectMembership,
  ProjectUpdate,
  TagAssignment,
} from '@cfp/shared/schemas';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly dataRepo: string;
  readonly evaluationsRef: string;
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

  return {
    dataRepo: resolve(dataRepoRaw),
    evaluationsRef:
      typeof opts['evaluations-ref'] === 'string' && opts['evaluations-ref'] !== ''
        ? opts['evaluations-ref']
        : 'spam-detection',
    branch:
      typeof opts['branch'] === 'string' && opts['branch'] !== ''
        ? opts['branch']
        : 'published',
    threshold: Number.isFinite(threshold) ? threshold : 0.8,
    dryRun: opts['dry-run'] === true,
    verbose: opts['verbose'] === true,
  };
}

// ---------------------------------------------------------------------------
// Verdict aggregation
// ---------------------------------------------------------------------------

interface PersonVerdict {
  /** Whether any evaluator gave spam confidence >= threshold. */
  hasConfidentSpam: boolean;
  /** Whether any evaluator gave a legit verdict at any confidence. */
  hasAnyLegit: boolean;
}

/**
 * Parse verdict and confidence from TOML content using line-regex
 * (tolerant, avoids pulling in a full TOML parser just for two fields).
 */
function parseEvaluationRecord(tomlContent: string): {
  verdict: string | null;
  confidence: number | null;
} {
  let verdict: string | null = null;
  let confidence: number | null = null;

  for (const line of tomlContent.split('\n')) {
    const trimmed = line.trim();
    const verdictMatch = trimmed.match(/^verdict\s*=\s*"([^"]+)"/);
    if (verdictMatch) {
      verdict = verdictMatch[1] ?? null;
      continue;
    }
    const confidenceMatch = trimmed.match(/^confidence\s*=\s*([0-9.]+)/);
    if (confidenceMatch) {
      const parsed = Number.parseFloat(confidenceMatch[1] ?? '');
      if (Number.isFinite(parsed)) confidence = parsed;
    }
  }

  return { verdict, confidence };
}

/**
 * Read all person-evaluations from the given ref via `git cat-file` bulk read.
 * Does NOT go through gitsheets — there are ~54k records and we want a
 * streaming git-native read. Returns a Map from personSlug → PersonVerdict.
 */
async function aggregateVerdicts(
  repo: string,
  evaluationsRef: string,
  threshold: number,
  log: (msg: string) => void,
): Promise<Map<string, PersonVerdict>> {
  log(`[prune-spam] listing person-evaluations under ref=${evaluationsRef}`);

  // List all blobs under person-evaluations/ in the evaluations ref.
  const lsOutput = await exec(
    'git',
    ['ls-tree', '-r', '--format=%(objectname) %(path)', evaluationsRef, 'person-evaluations/'],
    { cwd: repo, maxBuffer: 64 * 1024 * 1024 },
  );

  const lines = lsOutput.stdout.trim().split('\n').filter((l) => l.length > 0);
  log(`[prune-spam] found ${lines.length} evaluation records`);

  if (lines.length === 0) {
    return new Map();
  }

  // Build a batch-check-mailbox input: one object hash per line.
  // We'll use git cat-file --batch to stream all blob contents.
  const hashPathPairs: Array<{ hash: string; path: string }> = [];
  for (const line of lines) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const hash = line.slice(0, spaceIdx).trim();
    const path = line.slice(spaceIdx + 1).trim();
    if (hash && path.endsWith('.toml')) {
      hashPathPairs.push({ hash, path });
    }
  }

  log(`[prune-spam] streaming ${hashPathPairs.length} blobs via git cat-file`);

  // Stream all blobs. We pass hashes on stdin, get "<hash> blob <size>\n<content>\n" back.
  // Use child_process.spawn for streaming instead of execFile (fits in memory for this size).
  const { spawn } = await import('node:child_process');

  const verdictMap = new Map<string, PersonVerdict>();

  await new Promise<void>((resolvePromise, reject) => {
    const catFile = spawn('git', ['cat-file', '--batch'], { cwd: repo });

    let buffer = '';
    let currentExpected: { hash: string; path: string; size: number } | null = null;
    let contentAccum = '';
    let contentRead = 0;
    let inputIdx = 0;

    // Write all hashes to stdin
    const writeNext = (): void => {
      if (inputIdx >= hashPathPairs.length) {
        catFile.stdin.end();
        return;
      }
      const pair = hashPathPairs[inputIdx++];
      if (pair) {
        catFile.stdin.write(pair.hash + '\n');
      }
    };

    // Kick it off — write all at once (output is streamed back)
    for (const pair of hashPathPairs) {
      catFile.stdin.write(pair.hash + '\n');
    }
    catFile.stdin.end();

    catFile.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');

      // Process as many complete records as possible from buffer.
      while (buffer.length > 0) {
        if (currentExpected === null) {
          // Look for a header line: "<hash> blob <size>\n"
          const nlIdx = buffer.indexOf('\n');
          if (nlIdx === -1) break; // incomplete header
          const header = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 1);

          const parts = header.trim().split(' ');
          if (parts.length < 3) continue;
          const hash = parts[0]!;
          const size = Number.parseInt(parts[2] ?? '0', 10);

          // Find the corresponding path
          const pairEntry = hashPathPairs.find((p) => p.hash === hash);
          if (!pairEntry || !Number.isFinite(size)) continue;

          currentExpected = { hash, path: pairEntry.path, size };
          contentAccum = '';
          contentRead = 0;
        }

        if (currentExpected !== null) {
          // We need `size` bytes of content + 1 trailing newline
          const needed = currentExpected.size + 1 - contentRead;
          if (buffer.length < needed) {
            // Not enough yet
            contentAccum += buffer;
            contentRead += buffer.length;
            buffer = '';
            break;
          }
          const chunk2 = buffer.slice(0, needed);
          buffer = buffer.slice(needed);
          contentAccum += chunk2;

          // Parse the TOML
          const tomlContent = contentAccum.slice(0, currentExpected.size);
          const pathParts = currentExpected.path.split('/');
          // path is like: person-evaluations/<personSlug>/<evaluator>.toml
          const personSlug = pathParts[1];
          if (personSlug) {
            const { verdict, confidence } = parseEvaluationRecord(tomlContent);
            if (verdict !== null && confidence !== null) {
              let entry = verdictMap.get(personSlug);
              if (!entry) {
                entry = { hasConfidentSpam: false, hasAnyLegit: false };
                verdictMap.set(personSlug, entry);
              }
              if (verdict === 'spam' && confidence >= threshold) {
                (entry as { hasConfidentSpam: boolean }).hasConfidentSpam = true;
              }
              if (verdict === 'legit') {
                (entry as { hasAnyLegit: boolean }).hasAnyLegit = true;
              }
            }
          }

          currentExpected = null;
          contentAccum = '';
          contentRead = 0;
        }
      }
    });

    catFile.stderr.on('data', (d: Buffer) => {
      process.stderr.write(`[git cat-file stderr] ${d.toString()}`);
    });

    catFile.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file exited with code ${code}`));
      } else {
        resolvePromise();
      }
    });

    // Suppress unused variable warning — writeNext declared for clarity
    void writeNext;
  });

  return verdictMap;
}

/**
 * Compute the set of person slugs to prune:
 * prune iff hasConfidentSpam AND NOT hasAnyLegit.
 */
function computePruneSet(verdictMap: Map<string, PersonVerdict>): Set<string> {
  const pruneSet = new Set<string>();
  for (const [slug, v] of verdictMap) {
    if (v.hasConfidentSpam && !v.hasAnyLegit) {
      pruneSet.add(slug);
    }
  }
  return pruneSet;
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

  const memberPersonIds = new Set<string>();
  for await (const mem of q['project-memberships'].query()) {
    const pid = (mem as Record<string, unknown>)['personId'];
    if (typeof pid === 'string') memberPersonIds.add(pid);
  }

  const prune = candidates.filter((c) => !memberPersonIds.has(c.id));
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
  readonly personTagAssignmentsDeleted: number;
  readonly projectUpdatesAuthorNulled: number;
  readonly commitHash: string | null;
  readonly noChanges: boolean;
}

// ---------------------------------------------------------------------------
// Git helpers (mirroring import-laddr/importer.ts)
// ---------------------------------------------------------------------------

async function ensureBranchCheckedOut(repo: string, branch: string): Promise<void> {
  // Ensure the local branch ref exists (it should for 'published' in a fresh clone)
  try {
    await exec('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repo });
  } catch {
    // Try to create from origin/<branch>
    try {
      const result = await exec(
        'git',
        ['rev-parse', '--verify', `refs/remotes/origin/${branch}`],
        { cwd: repo },
      );
      const parentCommit = result.stdout.trim();
      await exec('git', ['update-ref', `refs/heads/${branch}`, parentCommit], { cwd: repo });
    } catch {
      throw new Error(`[prune-spam] branch '${branch}' not found in ${repo}`);
    }
  }

  // Point HEAD at the branch
  await exec('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: repo });
}

// ---------------------------------------------------------------------------
// Core prune logic
// ---------------------------------------------------------------------------

const AUTHOR_NAME = 'Code for Philly API';
const AUTHOR_EMAIL = 'api@users.noreply.codeforphilly.org';

async function pruneSpam(args: CliArgs): Promise<PruneSummary> {
  const log = args.verbose
    ? (msg: string) => console.log(msg)
    : (): void => {};

  // -------------------------------------------------------------------------
  // 1. Read verdicts from evaluations ref (efficient git read)
  // -------------------------------------------------------------------------
  log(`[prune-spam] reading verdicts from ref=${args.evaluationsRef}, threshold=${args.threshold}`);
  const verdictMap = await aggregateVerdicts(
    args.dataRepo,
    args.evaluationsRef,
    args.threshold,
    log,
  );

  const pruneSet = computePruneSet(verdictMap);
  log(
    `[prune-spam] evaluated=${verdictMap.size} persons, pruneSet=${pruneSet.size} (confident spam with no legit)`,
  );

  // -------------------------------------------------------------------------
  // 2. Open the published store
  // -------------------------------------------------------------------------
  log(`[prune-spam] switching ${args.dataRepo} HEAD → refs/heads/${args.branch}`);
  await ensureBranchCheckedOut(args.dataRepo, args.branch);

  const { store } = await openPublicStore(args.dataRepo);

  // -------------------------------------------------------------------------
  // 3. Count people before pruning
  // -------------------------------------------------------------------------
  let peopleBefore = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _p of store.people.query()) {
    peopleBefore++;
  }
  log(`[prune-spam] peopleBefore=${peopleBefore}`);

  if (args.dryRun) {
    // Apply the same partition (verdict candidates minus project members)
    // the real run uses, so the count is accurate.
    const { prune, protectedByMembership } = await partitionCandidates(
      store as unknown as Queryable,
      pruneSet,
    );
    console.log(
      `[prune-spam] dry-run: would prune ${prune.length} (of ${pruneSet.size} verdict-flagged slugs); ${protectedByMembership} protected by project membership`,
    );
    return {
      peopleBefore,
      prunedPeople: prune.length,
      peopleAfter: peopleBefore - prune.length,
      protectedByMembership,
      membershipsDeleted: 0,
      helpWantedInterestDeleted: 0,
      personTagAssignmentsDeleted: 0,
      projectUpdatesAuthorNulled: 0,
      commitHash: null,
      noChanges: true,
    };
  }

  // -------------------------------------------------------------------------
  // 4. One atomic transaction: delete people + cascade
  // -------------------------------------------------------------------------
  const runAt = new Date().toISOString();

  let prunedPeople = 0;
  let protectedByMembership = 0;
  let membershipsDeleted = 0;
  let helpWantedInterestDeleted = 0;
  let personTagAssignmentsDeleted = 0;
  let projectUpdatesAuthorNulled = 0;

  const result = await store.transact(
    {
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
      // --- Step A: Partition verdict candidates; protect project members ---
      // Real project involvement overrides a spam verdict, so candidates who
      // hold a project-membership are kept (see the spec).
      log(`[prune-spam] partitioning candidates (protecting project members)`);
      const { prune, protectedByMembership: protectedCount } = await partitionCandidates(
        tx as unknown as Queryable,
        pruneSet,
      );
      protectedByMembership = protectedCount;

      const prunedIds = new Set<string>(prune.map((c) => c.id));
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

      // --- Step B: Cascade-delete project-memberships ---
      // By construction members are protected from pruning, so this is
      // normally 0; kept as a defensive sweep for any stale membership.
      log(`[prune-spam] scanning project-memberships for cascade deletes`);
      for await (const mem of tx['project-memberships'].query()) {
        const m = mem as unknown as ProjectMembership;
        if (prunedIds.has(m.personId)) {
          await tx['project-memberships'].delete(mem as unknown as ProjectMembership);
          membershipsDeleted++;
        }
      }
      log(`[prune-spam] membershipsDeleted=${membershipsDeleted}`);

      // --- Step C: Cascade-delete help-wanted-interest (path: roleId/personId) ---
      log(`[prune-spam] scanning help-wanted-interest for cascade deletes`);
      for await (const interest of tx['help-wanted-interest'].query()) {
        const hw = interest as unknown as HelpWantedInterestExpression;
        if (prunedIds.has(hw.personId)) {
          await tx['help-wanted-interest'].delete(interest as unknown as HelpWantedInterestExpression);
          helpWantedInterestDeleted++;
        }
      }
      log(`[prune-spam] helpWantedInterestDeleted=${helpWantedInterestDeleted}`);

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

  return {
    peopleBefore,
    prunedPeople,
    peopleAfter,
    protectedByMembership,
    membershipsDeleted,
    helpWantedInterestDeleted,
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
