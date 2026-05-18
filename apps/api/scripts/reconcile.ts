/**
 * reconcile.ts — Cutover + post-cutover reconciliation
 *
 * Walks the public Person sheet and the private store and reports
 * inconsistencies across the four classes documented in
 * plans/cutover-prep.md and specs/behaviors/account-migration.md:
 *
 *   1. Orphan public Persons     — Person row with no matching PrivateProfile
 *   2. Orphan private profiles   — PrivateProfile with no matching Person
 *   3. Inconsistent newsletter   — newsletter.optedIn=true but no unsubscribeToken,
 *                                  or token without an optedIn payload
 *   4. Drained legacy passwords  — Person.githubUserId set but
 *                                  LegacyPasswordCredential still exists
 *
 * Output: a JSON report (machine-readable) preceded by a short human-readable
 * summary on stderr. Exit code is 0 when nothing was flagged, 1 when issues
 * remain *after* --fix has had a chance to repair the safe cases.
 *
 * --fix mode applies the safe repairs only:
 *   - regenerate missing unsubscribe tokens for opted-in profiles
 *   - delete LegacyPasswordCredential records when the Person is GitHub-linked
 *
 * Orphans (either direction) require human review and are never auto-fixed.
 *
 * Usage:
 *   npm run -w apps/api script:reconcile                   # report only
 *   npm run -w apps/api script:reconcile -- --fix          # report + repair safe cases
 *   npm run -w apps/api script:reconcile -- --json=out.json
 *
 * Reads CFP_DATA_REPO_PATH + STORAGE_BACKEND + bucket envs from the env, same
 * shape as the API.
 *
 * This script supersedes reconcile-private-store.ts (cutover-prep absorbed
 * its scope) — see plans/cutover-prep.md Notes.
 */
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  PrivateProfileSchema,
  type PrivateProfile,
} from '@cfp/shared/schemas';
import { openPublicStore, type PublicStore } from '../src/store/public.js';
import {
  FilesystemPrivateStore,
  S3PrivateStore,
  type PrivateStore,
} from '../src/store/private/index.js';

// ---------------------------------------------------------------------------
// Report types — exported for tests
// ---------------------------------------------------------------------------

export interface OrphanPublic {
  readonly personId: string;
  readonly slug: string;
}

export interface OrphanPrivate {
  readonly personId: string;
}

export interface InconsistentNewsletter {
  readonly personId: string;
  readonly reason: 'opted_in_without_token' | 'token_without_optin_payload';
}

export interface DrainedLegacyPassword {
  readonly personId: string;
  readonly slug: string;
  readonly githubUserId: number;
}

export interface ReconcileReport {
  readonly runAt: string;
  readonly publicPeopleCount: number;
  readonly privateProfileCount: number;
  readonly legacyPasswordCount: number;
  readonly orphanPublic: ReadonlyArray<OrphanPublic>;
  readonly orphanPrivate: ReadonlyArray<OrphanPrivate>;
  readonly inconsistentNewsletter: ReadonlyArray<InconsistentNewsletter>;
  readonly drainedLegacyPasswords: ReadonlyArray<DrainedLegacyPassword>;
  readonly fixesApplied: {
    readonly newsletterTokens: number;
    readonly legacyPasswordsDeleted: number;
  };
}

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function buildPrivateStore(): PrivateStore {
  const backend = requireEnv('STORAGE_BACKEND');
  if (backend === 's3') {
    return new S3PrivateStore({
      S3_ENDPOINT: requireEnv('S3_ENDPOINT'),
      S3_BUCKET: requireEnv('S3_BUCKET'),
      S3_ACCESS_KEY_ID: requireEnv('S3_ACCESS_KEY_ID'),
      S3_SECRET_ACCESS_KEY: requireEnv('S3_SECRET_ACCESS_KEY'),
      S3_REGION: requireEnv('S3_REGION'),
    });
  }
  return new FilesystemPrivateStore({
    CFP_PRIVATE_STORAGE_PATH: requireEnv('CFP_PRIVATE_STORAGE_PATH'),
  });
}

// ---------------------------------------------------------------------------
// Core reconcile (exported for tests)
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  readonly publicStore: PublicStore;
  readonly privateStore: PrivateStore;
  readonly fix?: boolean;
  readonly now?: string;
}

export async function reconcile(
  opts: ReconcileOptions,
): Promise<ReconcileReport> {
  const { publicStore, privateStore, fix = false } = opts;
  const runAt = opts.now ?? new Date().toISOString();

  const people = await publicStore.people.queryAll();
  const liveById = new Map<string, { id: string; slug: string; githubUserId: number | null | undefined }>();
  for (const p of people) {
    if (p.deletedAt) continue;
    liveById.set(p.id, {
      id: p.id,
      slug: p.slug,
      githubUserId: p.githubUserId ?? null,
    });
  }

  const orphanPublic: OrphanPublic[] = [];
  const orphanPrivate: OrphanPrivate[] = [];
  const inconsistentNewsletter: InconsistentNewsletter[] = [];
  const drainedLegacyPasswords: DrainedLegacyPassword[] = [];

  const profilesById = new Map<string, PrivateProfile>();
  let privateProfileCount = 0;

  for await (const profile of privateStore.listAllProfiles()) {
    privateProfileCount++;
    profilesById.set(profile.personId, profile);
    if (!liveById.has(profile.personId)) {
      orphanPrivate.push({ personId: profile.personId });
    }

    const nl = profile.newsletter;
    if (nl) {
      if (nl.optedIn && !nl.unsubscribeToken) {
        inconsistentNewsletter.push({
          personId: profile.personId,
          reason: 'opted_in_without_token',
        });
      } else if (!nl.optedIn && nl.unsubscribeToken && !nl.optedOutAt) {
        inconsistentNewsletter.push({
          personId: profile.personId,
          reason: 'token_without_optin_payload',
        });
      }
    }
  }

  for (const person of liveById.values()) {
    if (!profilesById.has(person.id)) {
      orphanPublic.push({ personId: person.id, slug: person.slug });
    }
    if (person.githubUserId) {
      const cred = await privateStore.getLegacyPassword(person.id);
      if (cred) {
        drainedLegacyPasswords.push({
          personId: person.id,
          slug: person.slug,
          githubUserId: person.githubUserId,
        });
      }
    }
  }

  const legacyPasswordCount = await privateStore.countLegacyPasswords();

  let newsletterTokens = 0;
  let legacyPasswordsDeleted = 0;

  if (fix) {
    for (const issue of inconsistentNewsletter) {
      if (issue.reason !== 'opted_in_without_token') continue;
      const profile = profilesById.get(issue.personId);
      if (!profile || !profile.newsletter) continue;
      const token = randomBytes(32).toString('base64url');
      const repaired: PrivateProfile = PrivateProfileSchema.parse({
        ...profile,
        newsletter: { ...profile.newsletter, unsubscribeToken: token },
        updatedAt: runAt,
      });
      await privateStore.putProfile(repaired);
      newsletterTokens++;
    }

    for (const drained of drainedLegacyPasswords) {
      await privateStore.deleteLegacyPassword(drained.personId);
      legacyPasswordsDeleted++;
    }
  }

  return {
    runAt,
    publicPeopleCount: liveById.size,
    privateProfileCount,
    legacyPasswordCount,
    orphanPublic,
    orphanPrivate,
    inconsistentNewsletter,
    drainedLegacyPasswords,
    fixesApplied: {
      newsletterTokens,
      legacyPasswordsDeleted,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly fix: boolean;
  readonly jsonPath: string | undefined;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let fix = false;
  let jsonPath: string | undefined;
  for (const a of argv) {
    if (a === '--fix') fix = true;
    else if (a.startsWith('--json=')) jsonPath = a.slice('--json='.length);
  }
  return { fix, jsonPath };
}

function summarize(report: ReconcileReport, fix: boolean): string {
  const lines: string[] = [];
  lines.push(`=== reconcile report (${report.runAt}) ===`);
  lines.push(`public people:          ${report.publicPeopleCount}`);
  lines.push(`private profiles:       ${report.privateProfileCount}`);
  lines.push(`legacy password creds:  ${report.legacyPasswordCount}`);
  lines.push(`orphan public Persons:  ${report.orphanPublic.length}`);
  for (const o of report.orphanPublic.slice(0, 10)) {
    lines.push(`  - ${o.slug} (${o.personId})`);
  }
  if (report.orphanPublic.length > 10) {
    lines.push(`  ...and ${report.orphanPublic.length - 10} more`);
  }
  lines.push(`orphan private profiles: ${report.orphanPrivate.length}`);
  for (const o of report.orphanPrivate.slice(0, 10)) lines.push(`  - ${o.personId}`);
  if (report.orphanPrivate.length > 10) {
    lines.push(`  ...and ${report.orphanPrivate.length - 10} more`);
  }
  lines.push(`inconsistent newsletter: ${report.inconsistentNewsletter.length}`);
  for (const i of report.inconsistentNewsletter.slice(0, 10)) {
    lines.push(`  - ${i.personId} (${i.reason})`);
  }
  lines.push(`drained legacy passwords: ${report.drainedLegacyPasswords.length}`);
  for (const d of report.drainedLegacyPasswords.slice(0, 10)) {
    lines.push(`  - ${d.slug} (${d.personId}) gh=${d.githubUserId}`);
  }
  if (fix) {
    lines.push('');
    lines.push(`fixes applied:`);
    lines.push(`  newsletter tokens regenerated: ${report.fixesApplied.newsletterTokens}`);
    lines.push(`  legacy passwords deleted:      ${report.fixesApplied.legacyPasswordsDeleted}`);
  }
  return lines.join('\n');
}

/**
 * Anything that needs human intervention. Even after --fix, orphan rows in
 * either direction stay listed — they require operator review.
 */
function unresolvedIssueCount(report: ReconcileReport): number {
  return (
    report.orphanPublic.length +
    report.orphanPrivate.length +
    // After --fix the safe-fix categories below should be empty, but if
    // --fix wasn't passed they still count as unresolved.
    report.inconsistentNewsletter.length +
    report.drainedLegacyPasswords.length -
    report.fixesApplied.newsletterTokens -
    report.fixesApplied.legacyPasswordsDeleted
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const repoPath = requireEnv('CFP_DATA_REPO_PATH');
  const { store: publicStore } = await openPublicStore(repoPath);
  const privateStore = buildPrivateStore();
  await privateStore.load();

  const report = await reconcile({
    publicStore,
    privateStore,
    fix: args.fix,
  });

  process.stderr.write(`${summarize(report, args.fix)}\n`);

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.jsonPath) {
    await writeFile(resolve(args.jsonPath), json, 'utf8');
  } else {
    process.stdout.write(json);
  }

  process.exitCode = unresolvedIssueCount(report) === 0 ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`reconcile failed: ${String(err)}\n`);
    process.exit(2);
  });
}
