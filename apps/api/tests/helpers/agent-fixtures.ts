/**
 * Shared fixtures for the agent tests (specs/api/agents.md,
 * specs/api/moderation.md): a data repo seeded in one commit, an app on it,
 * staff / administrator sessions, and an agent created through the API.
 *
 * Every name here is invented; none is a real member's.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { FastifyInstance } from 'fastify';
import { openRepo } from 'gitsheets';
import { expect } from 'vitest';

import { buildApp } from '../../src/app.js';
import { mintSessionFor } from '../../src/auth/issue.js';
import { createFullDataRepo, createPrivateStorageDir } from './test-full-repo.js';

const exec = promisify(execFile);

export const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const SEED_AUTHOR = { name: 'cfp test', email: 'test@cfp.test' };

export type Rec = Record<string, unknown>;

/** `n` → a stable UUIDv7-shaped id for fixtures. */
export const fid = (n: number): string => `01951a3c-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const minutesAgo = (m: number, now = Date.now()): string => new Date(now - m * 60_000).toISOString();
export const daysAgo = (d: number, now = Date.now()): string => new Date(now - d * 86_400_000).toISOString();

export function personRecord(n: number, slug: string, over: Rec = {}): Rec {
  const createdAt = (over['createdAt'] as string | undefined) ?? daysAgo(400);
  return {
    id: fid(n),
    slug,
    fullName: `Test ${slug}`,
    accountLevel: 'user',
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
}

export interface AgentTestEnv {
  readonly app: FastifyInstance;
  readonly dataPath: string;
  readonly privatePath: string;
  readonly cookie: (personN: number, level: 'user' | 'staff' | 'administrator') => Promise<string>;
  readonly git: (...args: string[]) => Promise<string>;
  readonly close: () => Promise<void>;
}

/**
 * A data repo holding `records` (sheet → records, written in one commit), a
 * private store holding `profiles`, and an app on both.
 */
export async function startAgentTestEnv(opts: {
  records: Record<string, Rec[]>;
  profiles?: Rec[];
  env?: Record<string, string>;
  /** More seeding in the same commit (attachments, raw files). */
  extra?: (tx: Parameters<Parameters<Awaited<ReturnType<typeof openRepo>>['transact']>[1]>[0]) => Promise<void>;
}): Promise<AgentTestEnv> {
  const dataRepo = await createFullDataRepo();
  const privateStore = await createPrivateStorageDir();
  const repo = await openRepo({ gitDir: dataRepo.path });
  await repo.transact({ message: 'seed agent fixtures', author: SEED_AUTHOR }, async (tx) => {
    for (const [sheet, records] of Object.entries(opts.records)) {
      for (const r of records) await tx.sheet(sheet).upsert(r, { allowMissingBody: true });
    }
    if (opts.extra) await opts.extra(tx);
  });
  if (opts.profiles?.length) {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(
      join(privateStore.path, 'profiles.jsonl'),
      opts.profiles.map((p) => JSON.stringify(p)).join('\n') + '\n',
    );
  }
  const app = await buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataRepo.path,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: JWT_KEY,
      NODE_ENV: 'test',
      ...opts.env,
    },
  });
  await app.ready();
  return {
    app,
    dataPath: dataRepo.path,
    privatePath: privateStore.path,
    cookie: async (n, level) => (await mintSessionFor(fid(n), level, JWT_KEY)).accessToken,
    git: async (...args) => (await exec('git', ['-C', dataRepo.path, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout,
    close: async () => {
      await app.close();
      await dataRepo.cleanup();
      await privateStore.cleanup();
    },
  };
}

export function privateProfile(personId: string, email: string, over: Rec = {}): Rec {
  return {
    personId,
    email,
    emailRefreshedAt: '2026-05-01T00:00:00.000Z',
    newsletter: null,
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...over,
  };
}

/** Create an agent account with one grant through the API, as an administrator. */
export async function createAgent(
  env: AgentTestEnv,
  adminCookie: string,
  opts: { slug: string; scopes: string[]; label?: string; expiresInDays?: number },
): Promise<{ token: string; grantId: string; personId: string }> {
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/admin/agents',
    cookies: { cfp_session: adminCookie },
    payload: {
      slug: opts.slug,
      fullName: `Example ${opts.slug}`,
      bio: 'An AI moderator run by the test suite. Its spam votes are staged; staff overrule them.',
      grant: { label: opts.label ?? 'test host', scopes: opts.scopes, expiresInDays: opts.expiresInDays ?? 90 },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json<{ data: { person: { id: string }; grant: { id: string }; token: string } }>().data;
  return { token: data.token, grantId: data.grant.id, personId: data.person.id };
}

/** Mint another grant for an existing agent. */
export async function mintGrant(
  env: AgentTestEnv,
  adminCookie: string,
  slug: string,
  scopes: string[],
): Promise<{ token: string; grantId: string }> {
  const res = await env.app.inject({
    method: 'POST',
    url: `/api/admin/agents/${slug}/grants`,
    cookies: { cfp_session: adminCookie },
    payload: { label: 'second host', scopes, expiresInDays: 30 },
  });
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json<{ data: { grant: { id: string }; token: string } }>().data;
  return { token: data.token, grantId: data.grant.id };
}

export const bearer = (token: string): { headers: { authorization: string } } => ({
  headers: { authorization: `Bearer ${token}` },
});
