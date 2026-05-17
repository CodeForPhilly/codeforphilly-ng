/**
 * Tests for apps/api/scripts/cutover-mailout.ts
 *
 * Covers recipient selection, email-body construction, and dry-run mode.
 * `send` mode is exercised against an injected fake send() that records calls.
 */
import { describe, expect, it } from 'vitest';
import { openRepo } from 'gitsheets';

import { buildEmailBody, runMailout } from '../scripts/cutover-mailout.js';
import { openPublicStore } from '../src/store/public.js';
import { FilesystemPrivateStore } from '../src/store/private/filesystem.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';

const NOW = '2026-08-15T00:00:00.000Z';

function uuid(n: number): string {
  return `01951a3c-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

async function seedPerson(
  repoPath: string,
  fields: { id: string; slug: string; fullName?: string; githubUserId?: number; deletedAt?: string },
): Promise<void> {
  const repo = await openRepo({ gitDir: `${repoPath}/.git`, workTree: repoPath });
  await repo.transact(
    { message: `seed person ${fields.slug}`, author: { name: 'test', email: 'test@cfp.test' } },
    async (tx) => {
      await tx.sheet('people').upsert({
        id: fields.id,
        slug: fields.slug,
        fullName: fields.fullName ?? 'Test Person',
        accountLevel: 'user',
        ...(fields.githubUserId !== undefined ? { githubUserId: fields.githubUserId } : {}),
        ...(fields.deletedAt !== undefined ? { deletedAt: fields.deletedAt } : {}),
        createdAt: NOW,
        updatedAt: NOW,
      });
    },
  );
}

describe('cutover-mailout', () => {
  it('selects only unclaimed Persons with valid emails', async () => {
    const repo = await createFullDataRepo();
    const priv = await createPrivateStorageDir();
    try {
      const privateStore = new FilesystemPrivateStore({
        CFP_PRIVATE_STORAGE_PATH: priv.path,
      });
      await privateStore.load();

      const aliceId = uuid(1); // unclaimed, valid email → recipient
      const bobId = uuid(2); // claimed (githubUserId set) → skipped
      const carolId = uuid(3); // unclaimed but no profile → skipped
      const danId = uuid(4); // unclaimed, invalid email → skipped
      const eveId = uuid(5); // deleted → skipped

      await seedPerson(repo.path, { id: aliceId, slug: 'alice', fullName: 'Alice A.' });
      await seedPerson(repo.path, { id: bobId, slug: 'bob', githubUserId: 12345 });
      await seedPerson(repo.path, { id: carolId, slug: 'carol' });
      await seedPerson(repo.path, { id: danId, slug: 'dan' });
      await seedPerson(repo.path, { id: eveId, slug: 'eve', deletedAt: NOW });

      const publicStore = await openPublicStore(repo.path);

      await privateStore.putProfile({
        personId: aliceId,
        email: 'alice@example.com',
        emailRefreshedAt: NOW,
        updatedAt: NOW,
      });
      await privateStore.putProfile({
        personId: bobId,
        email: 'bob@example.com',
        emailRefreshedAt: NOW,
        updatedAt: NOW,
      });
      // carol has no profile
      await privateStore.putProfile({
        personId: danId,
        email: 'dan@example.invalid',
        emailRefreshedAt: NOW,
        updatedAt: NOW,
      });

      const report = await runMailout({
        publicStore,
        privateStore,
        mode: 'dry-run',
        now: NOW,
      });

      expect(report.mode).toBe('dry-run');
      expect(report.recipients).toHaveLength(1);
      expect(report.recipients[0]?.slug).toBe('alice');
      expect(report.recipients[0]?.email).toBe('alice@example.com');
      expect(report.sent).toBe(0);

      const skipReasons = report.skipped.map((s) => s.reason).sort();
      expect(skipReasons).toEqual(['deleted', 'github-linked', 'invalid-email', 'no-private-profile']);
    } finally {
      await repo.cleanup();
      await priv.cleanup();
    }
  });

  it('builds a properly formatted email body', () => {
    const body = buildEmailBody(
      { personId: uuid(1), slug: 'alice', email: 'alice@example.com', fullName: 'Alice Adams' },
      'https://codeforphilly.org',
    );
    expect(body.subject).toBe('Action needed: claim your Code for Philly account');
    expect(body.text).toContain('Hi Alice Adams,');
    expect(body.text).toContain('@alice');
    expect(body.text).toContain('https://codeforphilly.org/account/sign-in');
    expect(body.html).toContain('<a href="https://codeforphilly.org/account/sign-in">');
    expect(body.html).not.toContain('&lt;');
  });

  it('escapes HTML in fullName', () => {
    const body = buildEmailBody(
      { personId: uuid(2), slug: 'x', email: 'x@example.com', fullName: '<script>alert(1)</script>' },
      'https://codeforphilly.org',
    );
    expect(body.html).not.toContain('<script>alert');
    expect(body.html).toContain('&lt;script&gt;');
  });

  it('calls send() for each recipient in send mode', async () => {
    const repo = await createFullDataRepo();
    const priv = await createPrivateStorageDir();
    try {
      const privateStore = new FilesystemPrivateStore({
        CFP_PRIVATE_STORAGE_PATH: priv.path,
      });
      await privateStore.load();

      const personId = uuid(7);
      await seedPerson(repo.path, { id: personId, slug: 'frank' });
      const publicStore = await openPublicStore(repo.path);
      await privateStore.putProfile({
        personId,
        email: 'frank@example.com',
        emailRefreshedAt: NOW,
        updatedAt: NOW,
      });

      const calls: Array<{ to: string; subject: string }> = [];
      const report = await runMailout({
        publicStore,
        privateStore,
        mode: 'send',
        send: async (input) => {
          calls.push({ to: input.to, subject: input.subject });
        },
        now: NOW,
      });
      expect(report.mode).toBe('send');
      expect(report.sent).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.to).toBe('frank@example.com');
    } finally {
      await repo.cleanup();
      await priv.cleanup();
    }
  });

  it('records failures without throwing', async () => {
    const repo = await createFullDataRepo();
    const priv = await createPrivateStorageDir();
    try {
      const privateStore = new FilesystemPrivateStore({
        CFP_PRIVATE_STORAGE_PATH: priv.path,
      });
      await privateStore.load();

      const personId = uuid(8);
      await seedPerson(repo.path, { id: personId, slug: 'gail' });
      const publicStore = await openPublicStore(repo.path);
      await privateStore.putProfile({
        personId,
        email: 'gail@example.com',
        emailRefreshedAt: NOW,
        updatedAt: NOW,
      });

      const report = await runMailout({
        publicStore,
        privateStore,
        mode: 'send',
        send: async () => {
          throw new Error('Resend 429');
        },
        now: NOW,
      });
      expect(report.sent).toBe(0);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0]?.error).toContain('Resend 429');
    } finally {
      await repo.cleanup();
      await priv.cleanup();
    }
  });
});
