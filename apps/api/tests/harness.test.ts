import { describe, expect, it } from 'vitest';

import { createTestRepo, seed } from './helpers/test-repo.js';
import { createTestPrivateStore } from './helpers/test-private-store.js';

describe('test harness — api', () => {
  it('placeholder: arithmetic works', () => {
    expect(1 + 1).toBe(2);
  });

  it('createTestRepo: create, upsert, queryFirst, cleanup', async () => {
    const { repo, cleanup } = await createTestRepo(['people']);
    try {
      await seed(repo, 'people', [
        {
          id: '01951a3c-0000-7000-8000-000000000001',
          slug: 'jane',
          fullName: 'Jane Doe',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        },
      ]);
      const sheet = await repo.openSheet('people');
      const found = await sheet.queryFirst({ slug: 'jane' });
      expect(found).toBeDefined();
      expect(found?.slug).toBe('jane');
    } finally {
      await cleanup();
    }
  });

  it('createTestPrivateStore: putProfile, getProfile, cleanup', async () => {
    const { store, cleanup } = await createTestPrivateStore();
    try {
      const profile = {
        personId: '01951a3c-0000-7000-8000-000000000001',
        email: 'jane@example.com',
        emailRefreshedAt: '2026-05-16T00:00:00Z',
        newsletter: { optedIn: false, optedInAt: null, unsubscribeToken: null },
        updatedAt: '2026-05-16T00:00:00Z',
      };
      await store.putProfile(profile);
      const retrieved = await store.getProfile(profile.personId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.email).toBe('jane@example.com');

      const found = await store.findPersonIdByEmail('jane@example.com');
      expect(found).toBe(profile.personId);
    } finally {
      await cleanup();
    }
  });
});
