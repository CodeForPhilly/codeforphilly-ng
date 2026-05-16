/**
 * Tests for the public + private store implementations.
 *
 * Uses createTestRepo() from the test harness for the gitsheets side and
 * FilesystemPrivateStore (the real backend) for the private side.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore } from 'gitsheets';

import { PersonSchema, ProjectSchema } from '@cfp/shared/schemas';
import { FilesystemPrivateStore } from '../src/store/private/filesystem.js';
import { Store } from '../src/store/store.js';
import { createTestRepo } from './helpers/test-repo.js';

const now = '2026-05-16T00:00:00Z';
const uuid = (n: number) => `01951a3c-0000-7000-8000-${String(n).padStart(12, '0')}`;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function makePrivateStore(): Promise<{ store: FilesystemPrivateStore; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cfp-private-'));
  await mkdir(dir, { recursive: true });
  const store = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: dir });
  await store.load();
  return {
    store,
    dir,
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

// -------------------------------------------------------------------------
// Tests: public store basics
// -------------------------------------------------------------------------

describe('public store (gitsheets)', () => {
  it('boots against createTestRepo and upserts a Project, queries it back', async () => {
    const { repo, cleanup } = await createTestRepo(['projects']);
    try {
      const store = await openStore(repo, { validators: { projects: ProjectSchema } });

      await store.transact(
        { message: 'test: upsert project', author: { name: 'test', email: 'test@cfp.test' } },
        async (tx) => {
          await tx['projects'].upsert({
            id: uuid(1),
            slug: 'my-project',
            title: 'My Project',
            stage: 'bootstrapping',
            featured: false,
            createdAt: now,
            updatedAt: now,
          });
        },
      );

      // Re-open the sheet after commit — the store's sheet object captures
      // the data tree at open time; re-opening resolves HEAD fresh.
      const freshSheet = await repo.openSheet('projects', { validator: ProjectSchema });
      const project = await freshSheet.queryFirst({ slug: 'my-project' });
      expect(project).toBeDefined();
      expect(project?.title).toBe('My Project');
      expect(project?.slug).toBe('my-project');
    } finally {
      await cleanup();
    }
  });

  it('path template renders correctly for projects sheet', async () => {
    const { repo, cleanup } = await createTestRepo(['projects']);
    try {
      const store = await openStore(repo, { validators: { projects: ProjectSchema } });

      const record = {
        id: uuid(1),
        slug: 'transit-app',
        title: 'Transit App',
        stage: 'prototyping' as const,
        featured: false,
        createdAt: now,
        updatedAt: now,
      };

      await store.transact(
        { message: 'test: upsert project', author: { name: 'test', email: 'test@cfp.test' } },
        async (tx) => {
          const result = await tx['projects'].upsert(record);
          // The path should contain the slug as the filename
          expect(result.path).toContain('transit-app');
        },
      );
    } finally {
      await cleanup();
    }
  });
});

// -------------------------------------------------------------------------
// Tests: Store (dual-store coordination)
// -------------------------------------------------------------------------

describe('Store (dual-store coordination)', () => {
  let privateStoreDir: string;
  let privateCleanup: () => Promise<void>;

  beforeEach(async () => {
    privateStoreDir = await mkdtemp(join(tmpdir(), 'cfp-private-'));
    privateCleanup = () => rm(privateStoreDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await privateCleanup();
  });

  it('boots a Store, upserts a Project and writes a PrivateProfile via transact', async () => {
    const { repo, cleanup: repoCleanup } = await createTestRepo(['projects', 'people']);
    const privateStore = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: privateStoreDir });
    await privateStore.load();

    try {
      const publicStore = await openStore(repo, {
        validators: { projects: ProjectSchema, people: PersonSchema },
      });
      const dualStore = new Store(publicStore, privateStore);

      const personId = uuid(10);

      // Insert a person into the public store and a PrivateProfile into the private store
      await dualStore.transact(
        { message: 'test: create person + profile', author: { name: 'test', email: 'test@cfp.test' } },
        async (tx) => {
          await tx.public['people'].upsert({
            id: personId,
            slug: 'janedoe',
            fullName: 'Jane Doe',
            accountLevel: 'user',
            createdAt: now,
            updatedAt: now,
          });

          tx.private.putProfile({
            personId,
            email: 'jane@example.com',
            emailRefreshedAt: now,
            updatedAt: now,
          });
        },
      );

      // Re-open the sheet after commit to get a fresh view of HEAD
      const freshPeople = await repo.openSheet('people', { validator: PersonSchema });
      const person = await freshPeople.queryFirst({ slug: 'janedoe' });
      expect(person).toBeDefined();
      expect(person?.fullName).toBe('Jane Doe');

      // Verify private side
      const profile = await privateStore.getProfile(personId);
      expect(profile).not.toBeNull();
      expect(profile?.email).toBe('jane@example.com');
    } finally {
      await repoCleanup();
    }
  });

  it('cross-store rollback: handler throw → no public commit, no private PUT', async () => {
    const { repo, cleanup: repoCleanup } = await createTestRepo(['projects']);
    const privateStore = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: privateStoreDir });
    await privateStore.load();

    try {
      const publicStore = await openStore(repo, { validators: { projects: ProjectSchema } });
      const dualStore = new Store(publicStore, privateStore);

      const personId = uuid(20);

      await expect(
        dualStore.transact(
          { message: 'test: rollback', author: { name: 'test', email: 'test@cfp.test' } },
          async (tx) => {
            tx.private.putProfile({
              personId,
              email: 'will-not-land@example.com',
              emailRefreshedAt: now,
              updatedAt: now,
            });
            // Simulate handler failure after staging mutations
            throw new Error('Deliberate handler failure');
          },
        ),
      ).rejects.toThrow('Deliberate handler failure');

      // Private profile should NOT exist
      const profile = await privateStore.getProfile(personId);
      expect(profile).toBeNull();
    } finally {
      await repoCleanup();
    }
  });

  it('dual-write: public commits, then private flush fails → error thrown, in-memory rolled back', async () => {
    const { repo, cleanup: repoCleanup } = await createTestRepo(['projects']);
    const privateStore = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: privateStoreDir });
    await privateStore.load();

    try {
      const publicStore = await openStore(repo, { validators: { projects: ProjectSchema } });

      const personId = uuid(50);

      // Use an impossible path so the private flush fails with ENOENT
      const badPrivateStore = new FilesystemPrivateStore({
        CFP_PRIVATE_STORAGE_PATH: '/dev/null/impossible-path',
      });
      await badPrivateStore.load(); // no files yet, loads empty
      const dualStoreWithBadPrivate = new Store(publicStore, badPrivateStore);

      await expect(
        dualStoreWithBadPrivate.transact(
          { message: 'test: dual-write failure', author: { name: 'test', email: 'test@cfp.test' } },
          async (tx) => {
            await tx.public['projects'].upsert({
              id: uuid(51),
              slug: 'dual-write-test',
              title: 'Dual Write Test',
              stage: 'bootstrapping',
              featured: false,
              createdAt: now,
              updatedAt: now,
            });

            tx.private.putProfile({
              personId,
              email: 'dual@example.com',
              emailRefreshedAt: now,
              updatedAt: now,
            });
          },
        ),
      ).rejects.toThrow();

      // Verify the public commit DID land — this is the load-bearing claim
      // of the reconciliation strategy: public is committed, private is
      // orphaned, manual recovery needed (not automatic git revert).
      const freshSheet = await repo.openSheet('projects', { validator: ProjectSchema });
      const project = await freshSheet.queryFirst({ slug: 'dual-write-test' });
      expect(project).toBeDefined();
      expect(project?.title).toBe('Dual Write Test');

      // In-memory state of badPrivateStore should be rolled back
      const profile = await badPrivateStore.getProfile(personId);
      expect(profile).toBeNull();
    } finally {
      await repoCleanup();
    }
  });

  it('writeOrder: private-first — private flush fails → public also not committed (unlike public-first)', async () => {
    // The key property of private-first mode: private is flushed INSIDE the
    // public.transact callback, before gitsheets commits. If private flush
    // throws, the callback exits with an error and gitsheets does NOT commit
    // the public tree. Neither side is committed — both are protected.
    //
    // This is the opposite of public-first, where public commits first and a
    // private failure leaves an orphan public record needing reconciliation.
    const { repo, cleanup: repoCleanup } = await createTestRepo(['people']);
    const personId = uuid(60);

    try {
      const publicStore = await openStore(repo, { validators: { people: PersonSchema } });
      const badPrivateStore = new FilesystemPrivateStore({
        CFP_PRIVATE_STORAGE_PATH: '/dev/null/impossible-path',
      });
      await badPrivateStore.load();
      const dualStore = new Store(publicStore, badPrivateStore);

      await expect(
        dualStore.transact(
          {
            message: 'test: private-first flush failure',
            author: { name: 'test', email: 'test@cfp.test' },
            writeOrder: 'private-first',
          },
          async (tx) => {
            tx.private.putProfile({
              personId,
              email: 'private-first@example.com',
              emailRefreshedAt: now,
              updatedAt: now,
            });
            await tx.public['people'].upsert({
              id: personId,
              slug: 'private-first-person',
              fullName: 'Private First Person',
              accountLevel: 'user',
              createdAt: now,
              updatedAt: now,
            });
            // Handler succeeds — but flushPrivate() will be called inside the
            // callback (private-first) and will fail with ENOENT on the bad path.
          },
        ),
      ).rejects.toThrow();

      // Public did NOT land — because private flush failed inside the callback,
      // gitsheets never committed the public tree. This is the defining
      // property of private-first: "if private fails, no public artifact exists."
      const freshPeople = await repo.openSheet('people', { validator: PersonSchema });
      const person = await freshPeople.queryFirst({ slug: 'private-first-person' });
      expect(person).toBeUndefined();
    } finally {
      await repoCleanup();
    }
  });
});

// -------------------------------------------------------------------------
// Tests: FilesystemPrivateStore
// -------------------------------------------------------------------------

describe('FilesystemPrivateStore', () => {
  it('persists and retrieves a profile across store instances', async () => {
    const { store, dir, cleanup } = await makePrivateStore();
    try {
      const personId = uuid(30);
      await store.putProfile({
        personId,
        email: 'test@example.com',
        emailRefreshedAt: now,
        updatedAt: now,
      });

      // Create a fresh store instance from the same directory and load it —
      // this actually exercises cross-instance persistence via disk.
      const freshStore = new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: dir });
      await freshStore.load();
      const profile = await freshStore.getProfile(personId);
      expect(profile).not.toBeNull();
      expect(profile?.email).toBe('test@example.com');
    } finally {
      await cleanup();
    }
  });

  it('findPersonIdByEmail is case-insensitive', async () => {
    const { store, cleanup } = await makePrivateStore();
    try {
      const personId = uuid(31);
      await store.putProfile({
        personId,
        email: 'jane@example.com',
        emailRefreshedAt: now,
        updatedAt: now,
      });

      expect(await store.findPersonIdByEmail('JANE@EXAMPLE.COM')).toBe(personId);
      expect(await store.findPersonIdByEmail('jane@example.com')).toBe(personId);
    } finally {
      await cleanup();
    }
  });

  it('deleteProfile removes the profile', async () => {
    const { store, cleanup } = await makePrivateStore();
    try {
      const personId = uuid(32);
      await store.putProfile({
        personId,
        email: 'delete-me@example.com',
        emailRefreshedAt: now,
        updatedAt: now,
      });
      expect(await store.getProfile(personId)).not.toBeNull();

      await store.deleteProfile(personId);
      expect(await store.getProfile(personId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('countLegacyPasswords returns 0 on empty store', async () => {
    const { store, cleanup } = await makePrivateStore();
    try {
      expect(await store.countLegacyPasswords()).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('transact: staged mutations are applied and flushed on success', async () => {
    const { store, cleanup } = await makePrivateStore();
    try {
      const personId = uuid(33);

      await store.transact(async (tx) => {
        tx.putProfile({
          personId,
          email: 'tx@example.com',
          emailRefreshedAt: now,
          updatedAt: now,
        });
      });

      const profile = await store.getProfile(personId);
      expect(profile).not.toBeNull();
      expect(profile?.email).toBe('tx@example.com');
    } finally {
      await cleanup();
    }
  });

  it('transact: staged mutations are rolled back on handler throw', async () => {
    const { store, cleanup } = await makePrivateStore();
    try {
      const personId = uuid(34);

      await expect(
        store.transact(async (tx) => {
          tx.putProfile({
            personId,
            email: 'never-lands@example.com',
            emailRefreshedAt: now,
            updatedAt: now,
          });
          throw new Error('Deliberate failure');
        }),
      ).rejects.toThrow('Deliberate failure');

      expect(await store.getProfile(personId)).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
