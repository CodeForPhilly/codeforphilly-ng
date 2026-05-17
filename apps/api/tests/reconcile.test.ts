/**
 * Tests for apps/api/scripts/reconcile.ts
 *
 * Each case exercises a single class of inconsistency against a fixture
 * built atop createFullDataRepo() + FilesystemPrivateStore.
 *
 *   - orphan public Person      (Person row exists, no PrivateProfile)
 *   - orphan private profile    (profile exists, no Person)
 *   - inconsistent newsletter   (opted-in without unsubscribeToken)
 *   - drained legacy password   (Person has githubUserId + LegacyPasswordCredential)
 *
 * --fix mode is verified on the two safe-fix cases (newsletter token + drained creds).
 */
import { describe, expect, it } from 'vitest';

import { openRepo } from 'gitsheets';
import { reconcile } from '../scripts/reconcile.js';
import { openPublicStore } from '../src/store/public.js';
import { FilesystemPrivateStore } from '../src/store/private/filesystem.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';

const NOW = '2026-08-15T00:00:00.000Z';
const FIXED_AT = '2026-08-15T12:00:00.000Z';

function uuid(n: number): string {
  return `01951a3c-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

interface Fixture {
  repo: Awaited<ReturnType<typeof createFullDataRepo>>;
  priv: Awaited<ReturnType<typeof createPrivateStorageDir>>;
  publicStore: Awaited<ReturnType<typeof openPublicStore>>;
  privateStore: FilesystemPrivateStore;
}

async function bootFixture(): Promise<Fixture> {
  const repo = await createFullDataRepo();
  const priv = await createPrivateStorageDir();
  const privateStore = new FilesystemPrivateStore({
    CFP_PRIVATE_STORAGE_PATH: priv.path,
  });
  await privateStore.load();
  const publicStore = await openPublicStore(repo.path);
  return { repo, priv, publicStore, privateStore };
}

async function teardown(f: Fixture): Promise<void> {
  await f.repo.cleanup();
  await f.priv.cleanup();
}

async function seedPerson(
  repoPath: string,
  fields: { id: string; slug: string; githubUserId?: number },
): Promise<void> {
  const repo = await openRepo({ gitDir: `${repoPath}/.git`, workTree: repoPath });
  await repo.transact(
    { message: `seed person ${fields.slug}`, author: { name: 'test', email: 'test@cfp.test' } },
    async (tx) => {
      await tx.sheet('people').upsert({
        id: fields.id,
        slug: fields.slug,
        fullName: 'Test Person',
        accountLevel: 'user',
        ...(fields.githubUserId !== undefined ? { githubUserId: fields.githubUserId } : {}),
        createdAt: NOW,
        updatedAt: NOW,
      });
    },
  );
}

describe('reconcile', () => {
  it('flags an orphan public Person', async () => {
    const f = await bootFixture();
    try {
      const personId = uuid(1);
      await seedPerson(f.repo.path, { id: personId, slug: 'alice' });
      // Re-open the store so it sees the new commit.
      const publicStore = await openPublicStore(f.repo.path);

      const report = await reconcile({
        publicStore,
        privateStore: f.privateStore,
        now: FIXED_AT,
      });

      expect(report.publicPeopleCount).toBe(1);
      expect(report.orphanPublic).toEqual([{ personId, slug: 'alice' }]);
      expect(report.orphanPrivate).toEqual([]);
      expect(report.inconsistentNewsletter).toEqual([]);
      expect(report.drainedLegacyPasswords).toEqual([]);
    } finally {
      await teardown(f);
    }
  });

  it('flags an orphan private profile', async () => {
    const f = await bootFixture();
    try {
      const personId = uuid(2);
      await f.privateStore.putProfile({
        personId,
        email: 'ghost@example.com',
        emailRefreshedAt: NOW,
        updatedAt: NOW,
      });

      const report = await reconcile({
        publicStore: f.publicStore,
        privateStore: f.privateStore,
        now: FIXED_AT,
      });

      expect(report.privateProfileCount).toBe(1);
      expect(report.orphanPrivate).toEqual([{ personId }]);
      expect(report.orphanPublic).toEqual([]);
    } finally {
      await teardown(f);
    }
  });

  it('flags a newsletter optedIn without unsubscribeToken and fixes it', async () => {
    const f = await bootFixture();
    try {
      const personId = uuid(3);
      await seedPerson(f.repo.path, { id: personId, slug: 'bob' });
      const publicStore = await openPublicStore(f.repo.path);
      await f.privateStore.putProfile({
        personId,
        email: 'bob@example.com',
        emailRefreshedAt: NOW,
        newsletter: { optedIn: true, optedInAt: NOW },
        updatedAt: NOW,
      });

      const reportBefore = await reconcile({
        publicStore,
        privateStore: f.privateStore,
        now: FIXED_AT,
      });
      expect(reportBefore.inconsistentNewsletter).toEqual([
        { personId, reason: 'opted_in_without_token' },
      ]);
      expect(reportBefore.fixesApplied.newsletterTokens).toBe(0);

      const reportAfter = await reconcile({
        publicStore,
        privateStore: f.privateStore,
        fix: true,
        now: FIXED_AT,
      });
      expect(reportAfter.fixesApplied.newsletterTokens).toBe(1);

      const profile = await f.privateStore.getProfile(personId);
      expect(profile?.newsletter?.unsubscribeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      await teardown(f);
    }
  });

  it('flags drained legacy passwords and deletes them under --fix', async () => {
    const f = await bootFixture();
    try {
      const personId = uuid(4);
      await seedPerson(f.repo.path, {
        id: personId,
        slug: 'carol',
        githubUserId: 99001,
      });
      const publicStore = await openPublicStore(f.repo.path);
      await f.privateStore.putProfile({
        personId,
        email: 'carol@example.com',
        emailRefreshedAt: NOW,
        updatedAt: NOW,
      });
      // Direct write to legacy-passwords.jsonl (test-only — production
      // never creates these outside the importer).
      const { writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await writeFile(
        join(f.priv.path, 'legacy-passwords.jsonl'),
        `${JSON.stringify({ personId, passwordHash: '$2y$12$abcdefghijklmnopqrstuv', importedAt: NOW })}\n`,
        'utf8',
      );
      // Re-load private store to pick up the new credential.
      const privateStore = new FilesystemPrivateStore({
        CFP_PRIVATE_STORAGE_PATH: f.priv.path,
      });
      await privateStore.load();
      // The profile we wrote earlier was via f.privateStore — re-write so the
      // re-loaded store also sees it.
      await privateStore.putProfile({
        personId,
        email: 'carol@example.com',
        emailRefreshedAt: NOW,
        updatedAt: NOW,
      });

      const reportBefore = await reconcile({
        publicStore,
        privateStore,
        now: FIXED_AT,
      });
      expect(reportBefore.drainedLegacyPasswords).toEqual([
        { personId, slug: 'carol', githubUserId: 99001 },
      ]);
      expect(reportBefore.fixesApplied.legacyPasswordsDeleted).toBe(0);

      const reportAfter = await reconcile({
        publicStore,
        privateStore,
        fix: true,
        now: FIXED_AT,
      });
      expect(reportAfter.fixesApplied.legacyPasswordsDeleted).toBe(1);

      expect(await privateStore.getLegacyPassword(personId)).toBeNull();
    } finally {
      await teardown(f);
    }
  });

  it('reports clean state with empty fixtures', async () => {
    const f = await bootFixture();
    try {
      const report = await reconcile({
        publicStore: f.publicStore,
        privateStore: f.privateStore,
        now: FIXED_AT,
      });
      expect(report.orphanPublic).toEqual([]);
      expect(report.orphanPrivate).toEqual([]);
      expect(report.inconsistentNewsletter).toEqual([]);
      expect(report.drainedLegacyPasswords).toEqual([]);
      expect(report.publicPeopleCount).toBe(0);
      expect(report.privateProfileCount).toBe(0);
      expect(report.legacyPasswordCount).toBe(0);
    } finally {
      await teardown(f);
    }
  });
});
