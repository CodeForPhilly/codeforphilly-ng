// Reconcile the private store against the public people sheet.
//
// Walks every Person in the public gitsheets repo and confirms each one has
// a corresponding `PrivateProfile` entry in the bucket. Flags orphans on
// both sides:
//
//   - public Person with no matching private profile
//   - private profile referencing a personId that does not exist publicly
//
// Optionally repairs missing private profiles with a `--fix` flag — creates
// a placeholder profile with `email: <slug>@example.invalid` so the API
// boot can find a row to read. Use `--fix` only in dev / disaster-recovery
// — production should investigate the underlying split before bulk-fixing.
//
// Usage:
//   npm run -w apps/api script:reconcile-private-store          # report only
//   npm run -w apps/api script:reconcile-private-store -- --fix # report + repair missing profiles
//
// Reads CFP_DATA_REPO_PATH + STORAGE_BACKEND + CFP_PRIVATE_STORAGE_PATH (or
// the S3 vars) from the env, same as the API.
import 'dotenv/config';
import { PrivateProfileSchema, type PrivateProfile } from '@cfp/shared/schemas';
import { openPublicStore } from '../src/store/public.js';
import { FilesystemPrivateStore } from '../src/store/private/filesystem.js';
import { S3PrivateStore } from '../src/store/private/s3.js';
import type { PrivateStore } from '../src/store/private/index.js';

interface ReconcileReport {
  readonly publicCount: number;
  readonly privateCount: number;
  readonly missingPrivateForPublic: ReadonlyArray<{ personId: string; slug: string }>;
  readonly orphanedPrivate: ReadonlyArray<{ personId: string }>;
}

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

async function reconcile(): Promise<ReconcileReport> {
  const repoPath = requireEnv('CFP_DATA_REPO_PATH');
  const publicStore = await openPublicStore(repoPath);
  const privateStore = buildPrivateStore();
  await privateStore.load();

  const people = await publicStore.people.queryAll();
  const publicIds = new Set(people.map((p) => p.id));

  const missingPrivateForPublic: Array<{ personId: string; slug: string }> = [];
  for (const person of people) {
    if (person.deletedAt) continue;
    const profile = await privateStore.getProfile(person.id);
    if (!profile) {
      missingPrivateForPublic.push({ personId: person.id, slug: person.slug });
    }
  }

  const orphanedPrivate: Array<{ personId: string }> = [];
  let privateCount = 0;
  for await (const profile of privateStore.listAllProfiles()) {
    privateCount++;
    if (!publicIds.has(profile.personId)) {
      orphanedPrivate.push({ personId: profile.personId });
    }
  }

  return {
    publicCount: people.length,
    privateCount,
    missingPrivateForPublic,
    orphanedPrivate,
  };
}

async function fixMissing(): Promise<number> {
  const repoPath = requireEnv('CFP_DATA_REPO_PATH');
  const publicStore = await openPublicStore(repoPath);
  const privateStore = buildPrivateStore();
  await privateStore.load();

  const people = await publicStore.people.queryAll();
  let fixed = 0;
  for (const person of people) {
    if (person.deletedAt) continue;
    const existing = await privateStore.getProfile(person.id);
    if (existing) continue;
    const now = new Date().toISOString();
    const profile: PrivateProfile = PrivateProfileSchema.parse({
      personId: person.id,
      email: `${person.slug}@example.invalid`,
      emailRefreshedAt: now,
      newsletter: null,
      updatedAt: now,
    });
    await privateStore.putProfile(profile);
    fixed++;
  }
  return fixed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wantFix = argv.includes('--fix');

  const report = await reconcile();

  process.stdout.write(`Public people:  ${report.publicCount}\n`);
  process.stdout.write(`Private profiles: ${report.privateCount}\n`);
  process.stdout.write(
    `Missing private for public: ${report.missingPrivateForPublic.length}\n`,
  );
  for (const m of report.missingPrivateForPublic) {
    process.stdout.write(`  - ${m.slug}  (${m.personId})\n`);
  }
  process.stdout.write(`Orphaned private profiles: ${report.orphanedPrivate.length}\n`);
  for (const o of report.orphanedPrivate) {
    process.stdout.write(`  - ${o.personId}\n`);
  }

  if (wantFix && report.missingPrivateForPublic.length > 0) {
    process.stdout.write(`\nApplying --fix...\n`);
    const fixed = await fixMissing();
    process.stdout.write(`Fixed ${fixed} missing profiles\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`reconcile-private-store failed: ${String(err)}\n`);
  process.exitCode = 1;
});
